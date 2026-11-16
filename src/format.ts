// Trims verbose TMDB/OMDb payloads to the fields an agent needs, keeping tool
// responses token-efficient. List endpoints get compact summaries; the get_*
// detail shapers keep the longer fields (overview, credits, etc.). Clients
// fetch and cache; all raw→agent-facing shaping lives here.
//
// Schema-first: each shaper builds its result and runs it through the matching
// Zod schema (same name + `Schema`) from ./format.schemas.ts via `.parse()`.
// That schema is also the tool's `outputSchema` (MCP structured content,
// SEP-2106), so a shaper that returns a field the schema doesn't know, or drops
// one it promised, throws right here.
import type { z } from "zod";
import {
  cardNotFoundSchema,
  cardRatingsSchema,
  collectionSchema,
  collectionMatchSchema,
  companySchema,
  creditsSchema,
  tvCreditsSchema,
  personDetailSchema,
  episodeBriefSchema,
  episodeSchema,
  findSchema,
  genresSchema,
  keywordsSchema,
  movieCardSchema,
  movieDetailSchema,
  movieSummarySchema,
  movieReleasesSchema,
  multiItemSchema,
  personCreditsSchema,
  personSummarySchema,
  ratingsSchema,
  reviewSchema,
  seasonSchema,
  tvCardSchema,
  tvDetailSchema,
  tvSummarySchema,
  videosSchema,
  watchProviderMatchesSchema,
  watchProvidersSchema,
} from "./format.schemas.ts";

// TMDB returns image fields as bare paths ("/abc.jpg"); the CDN base plus a
// size segment make them URLs. w500 is a good poster/profile default.
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w500";

function imageUrl(path: string | undefined): string | null {
  return path ? `${TMDB_IMAGE_BASE}${path}` : null;
}

// "1994-09-23" → 1994 (also OMDb's "2008–2013"/"2008–" series years). TMDB
// omits or blanks the date for unreleased entries; OMDb sends "N/A" → null.
function year(date: string | null | undefined): number | null {
  if (!date) return null;
  const y = Number(date.slice(0, 4));
  return Number.isFinite(y) && y > 0 ? y : null;
}

// TMDB reports vote_average 0 with vote_count 0 for titles nobody has rated
// (e.g. every unreleased movie). That means "no score", not 0/10.
function score(avg: number | undefined, count: number | undefined): number | null {
  return count === 0 ? null : (avg ?? null);
}

// TMDB encodes gender as an int; expose the human label instead.
function genderLabel(g: number | undefined): string | null {
  switch (g) {
    case 1:
      return "female";
    case 2:
      return "male";
    case 3:
      return "non-binary";
    default:
      return null;
  }
}

function names(list: { name?: string }[] | undefined): string[] {
  return (list ?? []).map((x) => x.name).filter((n): n is string => Boolean(n));
}

// Like names(), but keeps the id too (e.g. keyword ids for discover_*'s with_keywords).
function idNames(list: NamedRef[] | undefined): { id: number; name: string }[] {
  return (list ?? []).flatMap((x) => (x.id != null && x.name ? [{ id: x.id, name: x.name }] : []));
}

// Truncate free text (e.g. a review body) to `max` chars with an ellipsis.
function clip(text: string | undefined, max: number): string | null {
  if (!text) return null;
  return text.length <= max ? text : text.slice(0, max).trimEnd() + "…";
}

// Compact form of a TV show's next_/last_episode_to_air: the few fields worth
// surfacing (when the next episode airs, which was last). Parsed through
// episodeBriefSchema like every shaper, so drift throws here rather than inside
// tvDetailSchema.parse().
function episodeBrief(e: TmdbEpisodeBrief | undefined): z.infer<typeof episodeBriefSchema> | null {
  if (!e) return null;
  return episodeBriefSchema.parse({
    season_number: e.season_number ?? null,
    episode_number: e.episode_number ?? null,
    name: e.name || null,
    air_date: e.air_date || null,
  });
}

// Build a { country → certification } map from a movie's release_dates. A
// country can list several release types (theatrical, digital, …), each with
// its own (often blank) certification; keep the first non-empty one per
// country. Trimmed because TMDB pads some values (The Matrix's GR "K-8 ").
function movieCertifications(m: TmdbMovie): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of m.release_dates?.results ?? []) {
    const country = r.iso_3166_1;
    if (!country) continue;
    const cert = (r.release_dates ?? []).map((d) => d.certification?.trim()).find(Boolean);
    if (cert) out[country] = cert;
  }
  return out;
}

// { country → rating } from a TV show's content_ratings.
function tvCertifications(t: TmdbTv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of t.content_ratings?.results ?? []) {
    const rating = r.rating?.trim();
    if (r.iso_3166_1 && rating) out[r.iso_3166_1] = rating;
  }
  return out;
}

// Most countries have no TMDB certification data; falling back to the US rating
// (present for nearly everything) beats null. `certification_region` says which
// region the value came from, so callers can tell a fallback from a match.
function resolveCertification(
  certifications: Record<string, string>,
  region: string,
): { certification: string | null; certification_region: string } {
  if (certifications[region])
    return { certification: certifications[region], certification_region: region };
  if (certifications.US) return { certification: certifications.US, certification_region: "US" };
  // Object.entries keeps each value paired with its key, so the fallback needs
  // no `certifications[key]!` assertion.
  const [fallback] = Object.entries(certifications).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return fallback
    ? { certification: fallback[1], certification_region: fallback[0] }
    : { certification: null, certification_region: region };
}

// ---- raw TMDB shapes (only the fields we read) ------------------------------

interface NamedRef {
  id?: number;
  name?: string;
}

// TMDB hides adult and softcore titles only where the request takes
// include_adult (search/*, discover/*). Every other list (trending,
// recommendations, similar, theatrical lists, a collection's parts, a person's
// credits and known_for) returns them as-is and ignores
// include_adult/include_softcore. So this rule is applied to all of those
// lists, including a looked-up person's known_for; only the title a detail/find
// lookup asked for by id is left alone.
interface ExplicitFlags {
  adult?: boolean;
  softcore?: boolean;
}

function isExplicit(x: ExplicitFlags): boolean {
  return x.adult === true || x.softcore === true;
}

export function withoutExplicit<R extends { results?: ExplicitFlags[] }>(res: R): R {
  return { ...res, results: res.results?.filter((r) => !isExplicit(r)) };
}

// One shape for both media types (TmdbMultiItem extends both): a movie's
// keywords come back under `keywords`, a show's under `results`.
interface TmdbKeywords {
  keywords?: NamedRef[];
  results?: NamedRef[];
}

export interface TmdbMovie {
  id: number;
  imdb_id?: string;
  title?: string;
  original_title?: string;
  overview?: string;
  tagline?: string;
  release_date?: string;
  runtime?: number;
  status?: string;
  genres?: NamedRef[];
  genre_ids?: number[];
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
  original_language?: string;
  spoken_languages?: { english_name?: string; name?: string }[];
  production_companies?: NamedRef[];
  budget?: number;
  revenue?: number;
  homepage?: string;
  poster_path?: string;
  adult?: boolean;
  softcore?: boolean;
  origin_country?: string[];
  belongs_to_collection?: { id?: number; name?: string; poster_path?: string };
  // Appended via append_to_response=release_dates; carries certifications.
  release_dates?: {
    results?: {
      iso_3166_1?: string;
      release_dates?: { certification?: string; type?: number }[];
    }[];
  };
  // Appended via append_to_response=keywords.
  keywords?: TmdbKeywords;
}

export interface TmdbTv {
  id: number;
  name?: string;
  original_name?: string;
  overview?: string;
  tagline?: string;
  first_air_date?: string;
  last_air_date?: string;
  status?: string;
  in_production?: boolean;
  number_of_seasons?: number;
  number_of_episodes?: number;
  episode_run_time?: number[];
  adult?: boolean;
  softcore?: boolean;
  genres?: NamedRef[];
  genre_ids?: number[];
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
  original_language?: string;
  networks?: NamedRef[];
  created_by?: NamedRef[];
  poster_path?: string;
  homepage?: string;
  type?: string;
  next_episode_to_air?: TmdbEpisodeBrief;
  last_episode_to_air?: TmdbEpisodeBrief;
  seasons?: TvSeasonBrief[];
  external_ids?: { imdb_id?: string };
  // Appended via append_to_response=content_ratings.
  content_ratings?: { results?: { iso_3166_1?: string; rating?: string }[] };
  // Appended via append_to_response=keywords.
  keywords?: TmdbKeywords;
}

interface TmdbEpisodeBrief {
  air_date?: string;
  episode_number?: number;
  season_number?: number;
  name?: string;
}

interface TvSeasonBrief {
  season_number?: number;
  name?: string;
  episode_count?: number;
  air_date?: string;
}

export interface TmdbPerson {
  id: number;
  name?: string;
  also_known_as?: string[];
  biography?: string;
  birthday?: string;
  deathday?: string;
  place_of_birth?: string;
  known_for_department?: string;
  gender?: number;
  popularity?: number;
  imdb_id?: string;
  homepage?: string;
  profile_path?: string;
}

export interface TmdbCredits {
  cast?: {
    id?: number;
    name?: string;
    character?: string;
    order?: number;
    profile_path?: string;
  }[];
  crew?: { id?: number; name?: string; job?: string; department?: string }[];
}

// A trending/multi-search row can be a movie, tv show, or person.
export interface TmdbMultiItem extends Partial<TmdbMovie>, Partial<TmdbTv>, Partial<TmdbPerson> {
  id: number;
  media_type?: "movie" | "tv" | "person";
  known_for?: TmdbMultiItem[];
}

export interface TmdbPage<T> {
  page?: number;
  total_pages?: number;
  total_results?: number;
  results?: T[];
}

// ---- shapers ----------------------------------------------------------------

export function summarizeMovie(m: TmdbMovie): z.infer<typeof movieSummarySchema> {
  return movieSummarySchema.parse({
    id: m.id,
    media_type: "movie",
    title: m.title,
    original_title: m.original_title !== m.title ? m.original_title : undefined,
    year: year(m.release_date),
    release_date: m.release_date || null,
    vote_average: score(m.vote_average, m.vote_count),
    vote_count: m.vote_count ?? null,
    overview: m.overview || null,
    poster_url: imageUrl(m.poster_path),
  });
}

export function detailMovie(m: TmdbMovie, region: string): z.infer<typeof movieDetailSchema> {
  const certifications = movieCertifications(m);
  // Age/content rating for `region` (e.g. MPAA "PG-13"), falling back to US
  // then any available country when `region` has no data; full map below.
  const { certification, certification_region } = resolveCertification(certifications, region);
  return movieDetailSchema.parse({
    id: m.id,
    imdb_id: m.imdb_id || null,
    media_type: "movie",
    certification,
    certification_region,
    certifications,
    title: m.title,
    original_title: m.original_title,
    tagline: m.tagline || null,
    overview: m.overview || null,
    year: year(m.release_date),
    release_date: m.release_date || null,
    runtime_minutes: m.runtime || null,
    status: m.status || null,
    genres: names(m.genres),
    keywords: idNames(m.keywords?.keywords),
    vote_average: score(m.vote_average, m.vote_count),
    vote_count: m.vote_count ?? null,
    popularity: m.popularity ?? null,
    original_language: m.original_language || null,
    spoken_languages: (m.spoken_languages ?? [])
      .map((l) => l.english_name || l.name)
      .filter(Boolean),
    production_companies: names(m.production_companies),
    origin_country: m.origin_country ?? [],
    // Franchise/collection this movie belongs to (e.g. "The Dark Knight
    // Collection"); fetch the full set of parts with get_collection.
    collection: m.belongs_to_collection
      ? {
          id: m.belongs_to_collection.id,
          name: m.belongs_to_collection.name,
          poster_url: imageUrl(m.belongs_to_collection.poster_path),
        }
      : null,
    budget_usd: m.budget || null,
    revenue_usd: m.revenue || null,
    homepage: m.homepage || null,
    poster_url: imageUrl(m.poster_path),
    // Canonical TMDB web page.
    tmdb_url: `https://www.themoviedb.org/movie/${m.id}`,
    imdb_url: m.imdb_id ? `https://www.imdb.com/title/${m.imdb_id}/` : null,
  });
}

export function summarizeTv(t: TmdbTv): z.infer<typeof tvSummarySchema> {
  return tvSummarySchema.parse({
    id: t.id,
    media_type: "tv",
    name: t.name,
    original_name: t.original_name !== t.name ? t.original_name : undefined,
    year: year(t.first_air_date),
    first_air_date: t.first_air_date || null,
    vote_average: score(t.vote_average, t.vote_count),
    vote_count: t.vote_count ?? null,
    overview: t.overview || null,
    poster_url: imageUrl(t.poster_path),
  });
}

export function detailTv(t: TmdbTv, region: string): z.infer<typeof tvDetailSchema> {
  const certifications = tvCertifications(t);
  // Age/content rating for `region` (e.g. "TV-MA"), falling back to US then
  // any available country when `region` has no data; full map below.
  const { certification, certification_region } = resolveCertification(certifications, region);
  return tvDetailSchema.parse({
    id: t.id,
    imdb_id: t.external_ids?.imdb_id || null,
    media_type: "tv",
    certification,
    certification_region,
    certifications,
    name: t.name,
    original_name: t.original_name,
    tagline: t.tagline || null,
    overview: t.overview || null,
    type: t.type || null,
    year: year(t.first_air_date),
    first_air_date: t.first_air_date || null,
    last_air_date: t.last_air_date || null,
    status: t.status || null,
    in_production: t.in_production ?? null,
    // For airing shows, when the next episode drops (null once ended); plus the
    // most recently aired one.
    next_episode_to_air: episodeBrief(t.next_episode_to_air),
    last_episode_to_air: episodeBrief(t.last_episode_to_air),
    number_of_seasons: t.number_of_seasons ?? null,
    number_of_episodes: t.number_of_episodes ?? null,
    episode_run_time: t.episode_run_time ?? [],
    // Per-season summary (number, name, episode count, air date).
    seasons: (t.seasons ?? []).map((s) => ({
      season_number: s.season_number ?? null,
      name: s.name || null,
      episode_count: s.episode_count ?? null,
      air_date: s.air_date || null,
    })),
    genres: names(t.genres),
    keywords: idNames(t.keywords?.results),
    vote_average: score(t.vote_average, t.vote_count),
    vote_count: t.vote_count ?? null,
    popularity: t.popularity ?? null,
    original_language: t.original_language || null,
    networks: names(t.networks),
    created_by: names(t.created_by),
    homepage: t.homepage || null,
    poster_url: imageUrl(t.poster_path),
    tmdb_url: `https://www.themoviedb.org/tv/${t.id}`,
    imdb_url: t.external_ids?.imdb_id
      ? `https://www.imdb.com/title/${t.external_ids.imdb_id}/`
      : null,
  });
}

// Trims a full ratingsSchema result (get_movie/get_tv's shape) to the three
// headline numbers for get_movies/get_tv_shows cards; see cardRatingsSchema.
function compactRatings(
  r: z.infer<typeof ratingsSchema> | undefined,
): z.infer<typeof cardRatingsSchema> | undefined {
  if (!r) return undefined;
  return cardRatingsSchema.parse(
    r.found
      ? {
          found: true,
          imdb_rating: r.imdb_rating,
          rotten_tomatoes: r.rotten_tomatoes,
          metascore: r.metascore,
        }
      : { found: false, reason: r.reason },
  );
}

// get_movies/get_tv_shows per-id shapers: trim an already-shaped detail (plus
// any ratings getEnrichedDetail folded in) to a batch card.
export function movieCard(
  m: z.infer<typeof movieDetailSchema> & { ratings?: z.infer<typeof ratingsSchema> },
): z.infer<typeof movieCardSchema> {
  return movieCardSchema.parse({
    found: true,
    id: m.id,
    title: m.title,
    year: m.year,
    genres: m.genres,
    vote_average: m.vote_average,
    vote_count: m.vote_count,
    ratings: compactRatings(m.ratings),
  });
}

export function tvCard(
  t: z.infer<typeof tvDetailSchema> & { ratings?: z.infer<typeof ratingsSchema> },
): z.infer<typeof tvCardSchema> {
  return tvCardSchema.parse({
    found: true,
    id: t.id,
    name: t.name,
    year: t.year,
    genres: t.genres,
    vote_average: t.vote_average,
    vote_count: t.vote_count,
    number_of_seasons: t.number_of_seasons,
    number_of_episodes: t.number_of_episodes,
    ratings: compactRatings(t.ratings),
  });
}

// Shared "couldn't fetch this id" card for a batch entry whose fetch rejected.
// Promise.allSettled per id, so one bad id never fails the whole
// get_movies/get_tv_shows call.
export function notFoundCard(id: number, reason: string): z.infer<typeof cardNotFoundSchema> {
  return cardNotFoundSchema.parse({ found: false, id, reason });
}

export function detailPerson(p: TmdbPerson): z.infer<typeof personDetailSchema> {
  return personDetailSchema.parse({
    id: p.id,
    imdb_id: p.imdb_id || null,
    name: p.name,
    also_known_as: p.also_known_as ?? [],
    known_for_department: p.known_for_department || null,
    gender: genderLabel(p.gender),
    biography: p.biography || null,
    birthday: p.birthday || null,
    deathday: p.deathday || null,
    place_of_birth: p.place_of_birth || null,
    popularity: p.popularity ?? null,
    homepage: p.homepage || null,
    profile_url: imageUrl(p.profile_path),
    tmdb_url: `https://www.themoviedb.org/person/${p.id}`,
    imdb_url: p.imdb_id ? `https://www.imdb.com/name/${p.imdb_id}/` : null,
  });
}

// `castLimit` caps the long tail of bit-part actors that bloats credits.
export function summarizeCredits(c: TmdbCredits, castLimit = 20): z.infer<typeof creditsSchema> {
  const cast = (c.cast ?? [])
    .slice()
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
    .slice(0, castLimit)
    .map((x) => ({ id: x.id, name: x.name, character: x.character || null }));
  // Keep only the headline crew roles; full crew lists are mostly noise.
  // Movie-only: TMDB's /tv/{id}/credits never tags Director/Writer/Creator
  // (verified live on Breaking Bad, Stranger Things, Chernobyl, The Queen's
  // Gambit: the creator/writer/director appears only as "Executive Producer"),
  // so get_tv_credits uses summarizeTvCredits over /tv/{id}/aggregate_credits,
  // which does.
  const KEY_JOBS = new Set([
    "Director",
    "Writer",
    "Screenplay",
    "Producer",
    "Executive Producer",
    "Original Music Composer",
    "Director of Photography",
    "Creator",
  ]);
  const crew = (c.crew ?? [])
    .filter((x) => x.job && KEY_JOBS.has(x.job))
    .map((x) => ({ id: x.id, name: x.name, job: x.job, department: x.department }));
  return creditsSchema.parse({ cast, crew });
}

// /tv/{id}/aggregate_credits: one row per person (crew: per person AND
// department), each listing every role/job across the whole run with its own
// episode count. Unlike /tv/{id}/credits, which never tags Director/Writer (see
// summarizeCredits) and whose cast is only the latest season's regulars:
// verified live, Game of Thrones' equals season 8's 14 (no Sean Bean), The
// Office's season 9's 4 (no Steve Carell).
export interface TmdbAggregateCredits {
  cast?: {
    id?: number;
    name?: string;
    order?: number;
    total_episode_count?: number;
    roles?: { character?: string; episode_count?: number }[];
  }[];
  crew?: {
    id?: number;
    name?: string;
    department?: string;
    jobs?: { job?: string; episode_count?: number }[];
  }[];
}

// The TV crew jobs worth surfacing, in output order. Teleplay/Story are TV
// writing credits that movie credits rarely use. Capped per job because a long
// show credits dozens of directors (Game of Thrones: 19), most for 1-2
// episodes; the top few by episode count answer "who directed/wrote it". No
// "Creator": the aggregate endpoint doesn't use that job (verified live);
// get_tv's created_by carries it.
const TV_KEY_JOBS = [
  "Director",
  "Writer",
  "Teleplay",
  "Story",
  "Executive Producer",
  "Producer",
  "Original Music Composer",
  "Director of Photography",
];
const TV_CREW_PER_JOB = 5;

export function summarizeTvCredits(
  c: TmdbAggregateCredits,
  castLimit = 20,
): z.infer<typeof tvCreditsSchema> {
  // Ranked by episodes across the run (billing `order` only breaks ties): the
  // aggregate list mixes series regulars with hundreds of one-episode guests
  // (Breaking Bad: 348 people), and episode count separates them.
  const cast = (c.cast ?? [])
    .slice()
    .sort(
      (a, b) =>
        (b.total_episode_count ?? 0) - (a.total_episode_count ?? 0) ||
        (a.order ?? 999) - (b.order ?? 999),
    )
    .slice(0, castLimit)
    .map((x) => {
      const top = (x.roles ?? [])
        .slice()
        .sort((a, b) => (b.episode_count ?? 0) - (a.episode_count ?? 0))[0];
      return {
        id: x.id,
        name: x.name,
        character: top?.character || null,
        episode_count: x.total_episode_count ?? 0,
      };
    });
  const flat = (c.crew ?? []).flatMap((x) =>
    (x.jobs ?? []).map((j) => ({
      id: x.id,
      name: x.name,
      job: j.job,
      department: x.department,
      episode_count: j.episode_count ?? 0,
    })),
  );
  const crew = TV_KEY_JOBS.flatMap((job) =>
    flat
      .filter((x) => x.job === job)
      .sort((a, b) => b.episode_count - a.episode_count)
      .slice(0, TV_CREW_PER_JOB)
      .map((x) => ({ ...x, job })),
  );
  return tvCreditsSchema.parse({ cast, crew });
}

// Used directly by search_people (whose /search/person response carries no
// media_type at all) and by summarizeMultiItem's "person" case below.
// `includeExplicit`: the caller's include_adult on search_people/search_multi.
export function summarizePerson(
  item: TmdbMultiItem,
  includeExplicit = false,
): z.infer<typeof personSummarySchema> {
  return personSummarySchema.parse({
    id: item.id,
    media_type: "person",
    name: item.name,
    known_for_department: item.known_for_department || null,
    popularity: item.popularity ?? null,
    profile_url: imageUrl(item.profile_path),
    known_for: (item.known_for ?? [])
      .filter((k) => includeExplicit || !isExplicit(k))
      .map((k) => k.title || k.name)
      .filter(Boolean)
      .slice(0, 5),
  });
}

// Trending / multi-search dispatch by media_type; people carry known_for
// titles. Each branch's shaper already validates its output, so the dispatcher
// has no schema of its own.
export function summarizeMultiItem(
  item: TmdbMultiItem,
  includeExplicit = false,
): z.infer<typeof multiItemSchema> {
  switch (item.media_type) {
    case "tv":
      return summarizeTv(item);
    case "person":
      return summarizePerson(item, includeExplicit);
    case "movie":
    default:
      // Multi-search omits media_type on some rows; title vs name disambiguates.
      return item.title !== undefined ? summarizeMovie(item) : summarizeTv(item);
  }
}

// A type alias, not an interface: TS only synthesizes an index signature
// (needed for assignability to `Record<string, unknown>`, which tools/*.ts's
// jsonResult() boundary expects) on anonymous object types, not named
// interfaces.
// The highest page number TMDB serves on any paginated endpoint.
export const TMDB_MAX_PAGE = 500;

export type Page<S> = {
  results: S[];
  page: number;
  total_pages: number;
  total_results: number;
};

// Generic page wrapper reused by every list endpoint, not tied to one shaper,
// so not schema-validated here: `summarize` already validates each item, and
// the wrapper's own shape is simple enough for the tool-registration-site
// `pageSchema(itemSchema)` plus the client-side outputSchema check.
//
// total_pages is clamped to TMDB_MAX_PAGE: verified live, /discover/movie and
// /movie/{id}/similar report total_pages 1001 but reject any page above 500.
export function page<T, S>(res: TmdbPage<T>, summarize: (item: T) => S): Page<S> {
  return {
    results: (res.results ?? []).map(summarize),
    page: res.page ?? 1,
    total_pages: Math.min(res.total_pages ?? 1, TMDB_MAX_PAGE),
    total_results: res.total_results ?? res.results?.length ?? 0,
  };
}

export interface TmdbMovieReleases extends TmdbPage<TmdbMovie> {
  dates?: { minimum?: string; maximum?: string };
}

// /movie/now_playing and /movie/upcoming: a movie page plus the release-date
// window TMDB used for that list.
export function summarizeMovieReleases(
  res: TmdbMovieReleases,
): z.infer<typeof movieReleasesSchema> {
  return movieReleasesSchema.parse({
    ...page(res, summarizeMovie),
    dates: { minimum: res.dates?.minimum || null, maximum: res.dates?.maximum || null },
  });
}

export function summarizeGenres(genres: NamedRef[]): z.infer<typeof genresSchema> {
  return genresSchema.parse({ genres: genres.map((g) => ({ id: g.id, name: g.name })) });
}

export interface TmdbReview {
  author?: string;
  author_details?: { rating?: number; username?: string };
  content?: string;
  created_at?: string;
  url?: string;
}

// A user review: author, their 0–10 rating (if any), date, and the body
// (clipped; full reviews can run very long).
export function summarizeReview(r: TmdbReview): z.infer<typeof reviewSchema> {
  return reviewSchema.parse({
    author: r.author || r.author_details?.username || null,
    rating: r.author_details?.rating ?? null,
    created_at: r.created_at || null,
    content: clip(r.content, 1500),
    url: r.url || null,
  });
}

interface TmdbCollection {
  id?: number;
  name?: string;
  overview?: string;
  poster_path?: string;
  parts?: TmdbMovie[];
}

// Sorts after any real ISO date, so announced-but-undated parts (TMDB sends
// release_date "") land last instead of before the first film.
const UNDATED = "9999";

// A movie collection/franchise and its parts, ordered chronologically.
export function summarizeCollection(c: TmdbCollection): z.infer<typeof collectionSchema> {
  const parts = (c.parts ?? [])
    .slice()
    .sort((a, b) => (a.release_date || UNDATED).localeCompare(b.release_date || UNDATED));
  return collectionSchema.parse({
    id: c.id,
    name: c.name,
    overview: c.overview || null,
    poster_url: imageUrl(c.poster_path),
    parts: parts.filter((p) => !isExplicit(p)).map(summarizeMovie),
  });
}

export interface TmdbCollectionMatch {
  id: number;
  name?: string;
  original_name?: string;
  overview?: string;
  poster_path?: string;
  backdrop_path?: string;
  adult?: boolean;
  original_language?: string;
}

// A /search/collection row; feeds get_collection's id.
export function summarizeCollectionMatch(
  c: TmdbCollectionMatch,
): z.infer<typeof collectionMatchSchema> {
  return collectionMatchSchema.parse({
    id: c.id,
    name: c.name,
    overview: c.overview || null,
    poster_url: imageUrl(c.poster_path),
  });
}

export interface KeywordsResponse {
  results?: { id?: number; name?: string }[];
  page?: number;
  total_pages?: number;
  total_results?: number;
}

// Keyword ids feed discover_*'s `with_keywords`/`without_keywords` filters.
export function summarizeKeywords(r: KeywordsResponse): z.infer<typeof keywordsSchema> {
  return keywordsSchema.parse(page(r, (k) => ({ id: k.id, name: k.name })));
}

export interface TmdbCompany {
  id: number;
  name?: string;
  origin_country?: string;
  logo_path?: string;
}

// Company ids feed discover_*'s `with_companies` filter.
export function summarizeCompany(c: TmdbCompany): z.infer<typeof companySchema> {
  return companySchema.parse({
    id: c.id,
    name: c.name,
    origin_country: c.origin_country || null,
    logo_url: imageUrl(c.logo_path),
  });
}

// ---- watch providers --------------------------------------------------------

export interface ProviderEntry {
  provider_id?: number;
  provider_name?: string;
  logo_path?: string;
}
interface RegionProviders {
  link?: string;
  flatrate?: ProviderEntry[];
  rent?: ProviderEntry[];
  buy?: ProviderEntry[];
  free?: ProviderEntry[];
  ads?: ProviderEntry[];
}
export interface WatchProvidersResponse {
  id?: number;
  // Keyed by ISO-3166-1 country code, e.g. "US", "GB", "RU".
  results?: Record<string, RegionProviders>;
}

function providerNames(list: ProviderEntry[] | undefined): string[] {
  return (list ?? []).map((p) => p.provider_name?.trim()).filter((n): n is string => Boolean(n));
}

// Watch availability is region-specific (JustWatch data). We surface the
// caller's region plus the list of regions that have data, so the agent can
// retry.
export function summarizeWatchProviders(
  r: WatchProvidersResponse,
  region: string,
): z.infer<typeof watchProvidersSchema> {
  const all = r.results ?? {};
  const regions = Object.keys(all).sort();
  const here = all[region];
  if (!here) {
    return watchProvidersSchema.parse({ region, available: false, available_regions: regions });
  }
  return watchProvidersSchema.parse({
    region,
    available: true,
    link: here.link || null,
    streaming: providerNames(here.flatrate),
    free: providerNames(here.free),
    ads: providerNames(here.ads),
    rent: providerNames(here.rent),
    buy: providerNames(here.buy),
    available_regions: regions,
  });
}

// TMDB has ~800 movie / ~730 TV providers globally (269+ for the US alone), so
// match results are paginated (20 per page) like every other search_* tool.
const WATCH_PROVIDER_PAGE_SIZE = 20;

// TMDB's /watch/providers/{movie,tv} endpoint has no query parameter: it always
// returns every registered provider for that media type (and region, if given).
// So `search_watch_providers` fetches the full list once (cached, like
// get_movie_genres/get_tv_genres) and matches `query` here on every call.
// `providers` carries a precomputed lowercase name (see clients/tmdb.ts's
// searchWatchProviders) so repeated calls don't re-lowercase every entry. Feeds
// discover_*'s `with_watch_providers`, like search_keywords/search_companies
// feed with_keywords/with_companies.
export function summarizeWatchProviderMatches(
  providers: (ProviderEntry & { nameLower: string })[],
  query: string,
  pg = 1,
): z.infer<typeof watchProviderMatchesSchema> {
  const q = query.trim().toLowerCase();
  const matches = providers
    .filter(
      (p): p is ProviderEntry & { nameLower: string; provider_id: number; provider_name: string } =>
        typeof p.provider_id === "number" && Boolean(p.provider_name),
    )
    .filter((p) => p.nameLower.includes(q))
    .map((p) => ({
      provider_id: p.provider_id,
      provider_name: p.provider_name.trim(),
      logo_url: imageUrl(p.logo_path),
    }));
  const total_results = matches.length;
  const total_pages = Math.max(1, Math.ceil(total_results / WATCH_PROVIDER_PAGE_SIZE));
  const start = (pg - 1) * WATCH_PROVIDER_PAGE_SIZE;
  return watchProviderMatchesSchema.parse({
    results: matches.slice(start, start + WATCH_PROVIDER_PAGE_SIZE),
    page: pg,
    total_pages,
    total_results,
  });
}

// ---- person combined credits ------------------------------------------------

interface CombinedCreditEntry {
  id?: number;
  media_type?: "movie" | "tv";
  title?: string; // movies
  name?: string; // tv
  character?: string;
  job?: string;
  department?: string;
  release_date?: string; // movies
  first_air_date?: string; // tv
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
  genre_ids?: number[];
  adult?: boolean;
  softcore?: boolean;
}
export interface CombinedCredits {
  cast?: CombinedCreditEntry[];
  crew?: CombinedCreditEntry[];
}

// Keeps only the CombinedCreditEntry fields summarizePersonCredits reads, so
// the raw response can be cached (and reshaped per department/limit) without
// holding the full payload; a prolific person's is ~900 KB (Mel Blanc). Must
// list the same keys as CombinedCreditEntry above.
const CREDIT_KEYS = [
  "id",
  "media_type",
  "title",
  "name",
  "character",
  "job",
  "department",
  "release_date",
  "first_air_date",
  "vote_average",
  "vote_count",
  "popularity",
  "genre_ids",
] as const satisfies readonly (keyof CombinedCreditEntry)[];

export function trimCombinedCredits(c: CombinedCredits): CombinedCredits {
  const trim = (e: CombinedCreditEntry): CombinedCreditEntry =>
    Object.fromEntries(CREDIT_KEYS.filter((k) => k in e).map((k) => [k, e[k]]));
  // Explicit credits go before trimming drops the flags (see isExplicit).
  const keep = (e: CombinedCreditEntry): boolean => !isExplicit(e);
  return { cast: c.cast?.filter(keep).map(trim), crew: c.crew?.filter(keep).map(trim) };
}

// Movie and TV ids are separate TMDB namespaces (a person can have movie 1487
// AND tv 1487: Ron Perlman's Hellboy / Static Shock), so dedupe keys need both.
function creditKey(e: CombinedCreditEntry): string | undefined {
  return e.id === undefined ? undefined : `${e.media_type}:${e.id}`;
}

function creditTitle(e: CombinedCreditEntry): string | undefined {
  return e.title ?? e.name;
}
function creditYear(e: CombinedCreditEntry): number | null {
  return year(e.release_date ?? e.first_air_date);
}

// TMDB's per-credit `popularity` is the linked title's own score, not a measure
// of the role: a long-running talk show out-scores any single film, so
// unfiltered "Self" guest spots (Letterman, Kimmel, awards-show cameos, …)
// crowd out an actor's real roles. Excluded so the ranked list is about roles.
// The character text alone misses many: TMDB leaves `character` empty on a lot
// of talk/news-show guest spots (Samuel L. Jackson's The Colbert Report, LIVE
// with Kelly and Mark; verified live), and every one carries TV genre Talk
// (10767) or News (10763), so a TV credit in either genre counts as a
// self-appearance whatever its character says.
const SELF_APPEARANCE_TV_GENRES = new Set([10763, 10767]);
const isSelfAppearance = (e: CombinedCreditEntry): boolean =>
  /^(self|himself|herself)\b/i.test(e.character ?? "") ||
  (e.media_type === "tv" && (e.genre_ids ?? []).some((g) => SELF_APPEARANCE_TV_GENRES.has(g)));

// Repeat guest spots (or a title credited under several characters/jobs) would
// otherwise waste several of the capped slots on one title.
function dedupeByKey<T>(entries: T[], key: (e: T) => string | undefined): T[] {
  const seen = new Set<string>();
  return entries.filter((e) => {
    const k = key(e);
    if (k === undefined) return true;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Caps a popularity-sorted list to at most `limit` DISTINCT titles (by id),
// keeping every already-included title's remaining rows regardless of position:
// a multi-hyphenate crew credit (writer AND director AND producer on one film)
// would otherwise burn several capped slots on a single title. cast doesn't
// need this: dedupeByKey(id) already leaves one row per title, so a plain slice
// is title-accurate.
function capByUniqueTitle<T>(entries: T[], limit: number, idOf: (e: T) => string | undefined): T[] {
  const seenTitles = new Set<string>();
  const result: T[] = [];
  for (const e of entries) {
    const id = idOf(e);
    const isNewTitle = id !== undefined && !seenTitles.has(id);
    if (isNewTitle && seenTitles.size >= limit) continue;
    if (id !== undefined) seenTitles.add(id);
    result.push(e);
  }
  return result;
}

// A prolific person can have hundreds of credits; cap to the most popular so
// the result stays useful and token-bounded. `department` restricts crew to one
// of TMDB's fixed department values (e.g. "Directing"; the tool-facing
// PERSON_DEPARTMENTS enum in tools/tmdb/fields.ts lists them all) before
// capping, which is how to get a complete filmography for one role when other
// departments would crowd it out.
export function summarizePersonCredits(
  c: CombinedCredits,
  department?: string,
  limit = 25,
): z.infer<typeof personCreditsSchema> {
  const byPopularity = (a: CombinedCreditEntry, b: CombinedCreditEntry): number =>
    (b.popularity ?? 0) - (a.popularity ?? 0);
  const cast = dedupeByKey(
    (c.cast ?? []).filter((e) => !isSelfAppearance(e)).sort(byPopularity),
    creditKey,
  )
    .slice(0, limit)
    .map((e) => ({
      id: e.id,
      media_type: e.media_type,
      title: creditTitle(e),
      year: creditYear(e),
      character: e.character || null,
      vote_average: score(e.vote_average, e.vote_count),
    }));
  const crewSource = department
    ? (c.crew ?? []).filter((e) => e.department === department)
    : (c.crew ?? []);
  const crew = capByUniqueTitle(
    dedupeByKey(crewSource.slice().sort(byPopularity), (e) =>
      e.id !== undefined && e.job ? `${creditKey(e)}:${e.job}` : undefined,
    ),
    limit,
    creditKey,
  ).map((e) => ({
    id: e.id,
    media_type: e.media_type,
    title: creditTitle(e),
    year: creditYear(e),
    job: e.job || null,
    department: e.department || null,
  }));
  return personCreditsSchema.parse({ cast, crew });
}

// ---- videos -----------------------------------------------------------------

interface VideoEntry {
  name?: string;
  iso_639_1?: string;
  key?: string;
  site?: string;
  type?: string;
  official?: boolean;
  published_at?: string;
}
export interface VideosResponse {
  results?: VideoEntry[];
}

// Only YouTube videos get a usable watch URL; others are returned without one.
export function summarizeVideos(r: VideosResponse): z.infer<typeof videosSchema> {
  const results = (r.results ?? []).map((v) => ({
    name: v.name,
    language: v.iso_639_1 || null,
    type: v.type || null,
    site: v.site || null,
    official: v.official ?? null,
    url: v.site === "YouTube" && v.key ? `https://www.youtube.com/watch?v=${v.key}` : null,
    published_at: v.published_at || null,
  }));
  return videosSchema.parse({ results });
}

// ---- find by external id ----------------------------------------------------

interface FindResponse {
  movie_results?: TmdbMovie[];
  tv_results?: TmdbTv[];
  person_results?: TmdbMultiItem[];
  tv_episode_results?: {
    show_id?: number;
    season_number?: number;
    episode_number?: number;
    name?: string;
    air_date?: string;
  }[];
  // Always empty in practice (verified live), so not surfaced.
  tv_season_results?: unknown[];
}

export function summarizeFind(r: FindResponse): z.infer<typeof findSchema> {
  return findSchema.parse({
    movie_results: (r.movie_results ?? []).map(summarizeMovie),
    tv_results: (r.tv_results ?? []).map(summarizeTv),
    // /find person rows carry the same fields as /search/person rows.
    person_results: (r.person_results ?? []).map((p) => summarizePerson(p)),
    tv_episode_results: (r.tv_episode_results ?? []).flatMap(
      ({ show_id, season_number, episode_number, ...e }) =>
        show_id === undefined || season_number === undefined || episode_number === undefined
          ? []
          : [{ ...episodeBrief(e)!, show_id, season_number, episode_number }],
    ),
  });
}

// ---- TV season & episode ----------------------------------------------------

interface RawEpisode {
  episode_number?: number;
  name?: string;
  overview?: string;
  air_date?: string;
  runtime?: number;
  vote_average?: number;
  still_path?: string;
  guest_stars?: { id?: number; name?: string; character?: string }[];
  crew?: { id?: number; name?: string; job?: string }[];
  // Only on the single-episode endpoint, via append_to_response=external_ids
  // (see clients/tmdb.ts's getTvEpisode); the season endpoint's episode rows
  // never carry it, so summarizeSeason's episodes stay id-less.
  external_ids?: { imdb_id?: string };
}
export interface TmdbSeason {
  id?: number;
  name?: string;
  season_number?: number;
  air_date?: string;
  overview?: string;
  poster_path?: string;
  episodes?: RawEpisode[];
}

// `episodeLimit` caps "Specials" seasons that accumulate hundreds of
// bonus/promo clips over a long-running show's lifetime (300+ for some) and
// would otherwise blow past a reasonable response size. `episode_count` still
// reports the true total; `episodes` is the capped list.
// `includeEpisodeOverview` is false for getTvSeasonsBulk's multi-season
// aggregate (get_tv's expand_episodes): an overview per episode across up to
// 250 episodes dwarfs every other field, so the aggregate drops it; call
// get_tv_season for one season's full detail.
export function summarizeSeason(
  s: TmdbSeason,
  episodeLimit = 50,
  includeEpisodeOverview = true,
): z.infer<typeof seasonSchema> {
  const episodes = s.episodes ?? [];
  return seasonSchema.parse({
    season_number: s.season_number ?? null,
    name: s.name || null,
    air_date: s.air_date || null,
    overview: s.overview || null,
    poster_url: imageUrl(s.poster_path),
    episode_count: episodes.length,
    episodes: episodes.slice(0, episodeLimit).map((e) => ({
      episode_number: e.episode_number ?? null,
      name: e.name || null,
      air_date: e.air_date || null,
      runtime_minutes: e.runtime || null,
      vote_average: e.vote_average || null,
      overview: includeEpisodeOverview ? e.overview || null : null,
    })),
  });
}

// Re-validate a seasons array assembled outside summarizeSeason: the
// expand_episodes flow in clients/tmdb.ts fetches, caps and merges hand-built
// "skipped" season objects, none of which re-run seasonSchema on the final
// array. This gives the aggregate the same drift guarantee as the per-season
// shaper.
export function parseSeasons(seasons: unknown): z.infer<typeof seasonSchema>[] {
  return seasonSchema.array().parse(seasons);
}

export function summarizeEpisode(
  e: RawEpisode & { season_number?: number },
): z.infer<typeof episodeSchema> {
  const imdbId = e.external_ids?.imdb_id || null;
  return episodeSchema.parse({
    season_number: e.season_number ?? null,
    episode_number: e.episode_number ?? null,
    imdb_id: imdbId,
    imdb_url: imdbId ? `https://www.imdb.com/title/${imdbId}/` : null,
    name: e.name || null,
    air_date: e.air_date || null,
    runtime_minutes: e.runtime || null,
    vote_average: e.vote_average || null,
    overview: e.overview || null,
    still_url: imageUrl(e.still_path),
    guest_stars: (e.guest_stars ?? [])
      .slice(0, 15)
      .map((g) => ({ id: g.id, name: g.name, character: g.character || null })),
    crew: (e.crew ?? [])
      .filter((x) => x.job === "Director" || x.job === "Writer")
      .map((x) => ({ id: x.id, name: x.name, job: x.job })),
  });
}

// ---- OMDb -------------------------------------------------------------------

// OMDb returns 200 even for "not found" with { Response: "False", Error }.
export interface OmdbResponse {
  Response?: "True" | "False";
  Error?: string;
  Title?: string;
  Year?: string;
  Rated?: string;
  Released?: string;
  Runtime?: string;
  Genre?: string;
  Director?: string;
  Writer?: string;
  Actors?: string;
  Plot?: string;
  Language?: string;
  Country?: string;
  Awards?: string;
  Metascore?: string;
  imdbRating?: string;
  imdbVotes?: string;
  imdbID?: string;
  Type?: string;
  Ratings?: { Source?: string; Value?: string }[];
}

// OMDb fills every missing string field with the literal "N/A".
function na(s: string | undefined): string | null {
  return s && s !== "N/A" ? s : null;
}

// `notFoundOk: true` (the default) returns a soft { found: false } object
// instead of throwing, so enrichment never fails a TMDB lookup.
export function summarizeRatings(r: OmdbResponse): z.infer<typeof ratingsSchema> {
  if (r.Response === "False") {
    // OMDb returns a clear "Movie not found!" for a title miss but the generic
    // "Error getting data." for an unrecognized imdb_id, which reads as an
    // upstream failure. Map it to a clearer reason so a caller can tell the two
    // apart.
    const reason =
      r.Error === "Error getting data." ? "No OMDb match for this imdb_id/title" : r.Error;
    return ratingsSchema.parse({ found: false, reason: reason || "No OMDb match" });
  }
  const ratings = (r.Ratings ?? []).map((x) => ({ source: x.Source, value: x.Value }));
  const rt = ratings.find((x) => x.source === "Rotten Tomatoes")?.value || null;
  return ratingsSchema.parse({
    found: true,
    imdb_id: na(r.imdbID),
    title: na(r.Title),
    year: na(r.Year),
    rated: na(r.Rated),
    runtime: na(r.Runtime),
    imdb_rating: na(r.imdbRating),
    imdb_votes: na(r.imdbVotes),
    metascore: na(r.Metascore),
    rotten_tomatoes: rt,
    awards: na(r.Awards),
    ratings,
  });
}

// A validated { found: false } ratings object. Enrichment builds several
// "couldn't enrich" outcomes by hand (key not configured, no imdb_id, lookup
// failed, title mismatch); routing them through here keeps them under the same
// ratingsSchema.parse guarantee as success.
export function ratingsNotFound(reason: string): z.infer<typeof ratingsSchema> {
  return ratingsSchema.parse({ found: false, reason });
}

// Does an OMDb-by-imdb_id hit look like a *different* work than the TMDB entry
// it enriches? TMDB's imdb_id is occasionally stale or wrong, and an id lookup
// then silently returns an unrelated title's ratings/awards. Titles can't be
// compared reliably (TMDB localizes them), but release years are
// language-independent: a gap wider than a couple of years is a strong "wrong
// id" signal. Returns false when either year is unknown, so a legitimate hit is
// never dropped over missing data.
export function ratingsYearConflict(
  tmdbDate: string | null | undefined,
  omdbYear: string | null | undefined,
): boolean {
  const a = year(tmdbDate);
  const b = year(omdbYear);
  if (a === null || b === null) return false;
  return Math.abs(a - b) > 2;
}
