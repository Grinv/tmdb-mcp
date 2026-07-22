// Trims verbose TMDB/OMDb payloads down to the fields an agent actually needs,
// keeping tool responses token-efficient. List endpoints get compact summaries;
// the get_* detail shapers keep the longer fields (overview, credits, etc.).
// Clients fetch + cache; all raw→agent-facing shaping lives here.
//
// Schema-first: each shaper below builds its result then runs it through the
// matching Zod schema of the same name (+ `Schema`) from ./format.schemas.ts
// via `.parse()` — the same schema used as the tool's `outputSchema` (MCP
// structured content, SEP-2106). A shaper that starts returning a field its
// schema doesn't know about (or drops one it promised) throws immediately,
// right here, instead of only surfacing as silent drift between two
// independently-maintained files.
import type { z } from "zod";
import {
  cardNotFoundSchema,
  cardRatingsSchema,
  collectionSchema,
  creditsSchema,
  personDetailSchema,
  episodeSchema,
  findSchema,
  genresSchema,
  keywordsSchema,
  movieCardSchema,
  movieDetailSchema,
  movieSummarySchema,
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
  watchProvidersSchema,
} from "./format.schemas.js";

// TMDB returns image fields as bare paths ("/abc.jpg"); the CDN base + a size
// segment make them usable URLs. w500 is a good poster/profile default.
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w500";

function imageUrl(path: string | null | undefined): string | null {
  return path ? `${TMDB_IMAGE_BASE}${path}` : null;
}

// "1994-09-23" → 1994. TMDB omits or blanks the date for unreleased entries.
function year(date: string | null | undefined): number | null {
  if (!date) return null;
  const y = Number(date.slice(0, 4));
  return Number.isFinite(y) && y > 0 ? y : null;
}

// TMDB encodes gender as an int; expose the human label instead.
function genderLabel(g: number | null | undefined): string | null {
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

// Truncate free text (e.g. a review body) to `max` chars with an ellipsis.
function clip(text: string | null | undefined, max: number): string | null {
  if (!text) return null;
  return text.length <= max ? text : text.slice(0, max).trimEnd() + "…";
}

// Compact form of a TV show's next_/last_episode_to_air — the handful of fields
// worth surfacing ("when does the next episode air", which one was last).
// Validated as part of the enclosing detailTv's tvDetailSchema.parse(), not
// separately — it's a nested piece, not one of format.schemas.ts's top-level
// per-tool schemas.
function episodeBrief(e: TmdbEpisodeBrief | null | undefined): Record<string, unknown> | null {
  if (!e) return null;
  return {
    season_number: e.season_number ?? null,
    episode_number: e.episode_number ?? null,
    name: e.name || null,
    air_date: e.air_date || null,
  };
}

// Build a { country → certification } map from a movie's release_dates. A country
// can list several release types (theatrical, digital, …), each with its own
// (often blank) certification; we keep the first non-empty one per country.
function movieCertifications(m: TmdbMovie): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of m.release_dates?.results ?? []) {
    const country = r.iso_3166_1;
    if (!country) continue;
    const cert = (r.release_dates ?? []).map((d) => d.certification).find((c) => c && c.trim());
    if (cert) out[country] = cert;
  }
  return out;
}

// { country → rating } from a TV show's content_ratings.
function tvCertifications(t: TmdbTv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of t.content_ratings?.results ?? []) {
    if (r.iso_3166_1 && r.rating && r.rating.trim()) out[r.iso_3166_1] = r.rating;
  }
  return out;
}

// Most countries have no TMDB certification data at all; falling back to the
// US rating (present for nearly everything) beats returning null whenever the
// requested region has none. `certification_region` reflects whichever region
// the value actually came from, so callers can tell a fallback from a match.
function resolveCertification(
  certifications: Record<string, string>,
  region: string,
): { certification: string | null; certification_region: string } {
  if (certifications[region])
    return { certification: certifications[region], certification_region: region };
  if (certifications.US) return { certification: certifications.US, certification_region: "US" };
  const [fallbackRegion] = Object.keys(certifications).sort();
  return fallbackRegion
    ? { certification: certifications[fallbackRegion]!, certification_region: fallbackRegion }
    : { certification: null, certification_region: region };
}

// ---- raw TMDB shapes (only the fields we read) ------------------------------

interface NamedRef {
  id?: number;
  name?: string;
}

export interface TmdbMovie {
  id: number;
  imdb_id?: string | null;
  title?: string;
  original_title?: string;
  overview?: string;
  tagline?: string;
  release_date?: string;
  runtime?: number | null;
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
  homepage?: string | null;
  poster_path?: string | null;
  adult?: boolean;
  origin_country?: string[];
  belongs_to_collection?: { id?: number; name?: string; poster_path?: string | null } | null;
  // Appended via append_to_response=release_dates; carries certifications.
  release_dates?: {
    results?: {
      iso_3166_1?: string;
      release_dates?: { certification?: string; type?: number }[];
    }[];
  };
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
  genres?: NamedRef[];
  genre_ids?: number[];
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
  original_language?: string;
  networks?: NamedRef[];
  created_by?: NamedRef[];
  poster_path?: string | null;
  homepage?: string | null;
  type?: string;
  next_episode_to_air?: TmdbEpisodeBrief | null;
  last_episode_to_air?: TmdbEpisodeBrief | null;
  seasons?: TvSeasonBrief[];
  external_ids?: { imdb_id?: string | null };
  // Appended via append_to_response=content_ratings.
  content_ratings?: { results?: { iso_3166_1?: string; rating?: string }[] };
}

export interface TmdbEpisodeBrief {
  air_date?: string | null;
  episode_number?: number;
  season_number?: number;
  name?: string;
}

interface TvSeasonBrief {
  season_number?: number;
  name?: string;
  episode_count?: number;
  air_date?: string | null;
}

export interface TmdbPerson {
  id: number;
  name?: string;
  also_known_as?: string[];
  biography?: string;
  birthday?: string | null;
  deathday?: string | null;
  place_of_birth?: string | null;
  known_for_department?: string;
  gender?: number;
  popularity?: number;
  imdb_id?: string | null;
  homepage?: string | null;
  profile_path?: string | null;
}

export interface TmdbCredits {
  cast?: {
    id?: number;
    name?: string;
    character?: string;
    order?: number;
    profile_path?: string | null;
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
    vote_average: m.vote_average ?? null,
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
    runtime_minutes: m.runtime ?? null,
    status: m.status || null,
    genres: names(m.genres),
    vote_average: m.vote_average ?? null,
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
    // tmdb_url is handy for users who want the canonical web page.
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
    vote_average: t.vote_average ?? null,
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
    vote_average: t.vote_average ?? null,
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

// Trims a full ratingsSchema result (get_movie/get_tv's shape) down to just
// the three headline numbers for get_movies/get_tv_shows' cards — see
// cardRatingsSchema for which fields that drops.
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

// get_movies/get_tv_shows' per-id shapers: take an already-shaped detail (plus
// whatever ratings getEnrichedDetail folded in) and trim it to a batch card.
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
    year: year(t.first_air_date),
    genres: t.genres,
    vote_average: t.vote_average,
    vote_count: t.vote_count,
    ratings: compactRatings(t.ratings),
  });
}

// Shared "couldn't fetch this id" card for a batch entry whose individual
// fetch rejected — Promise.allSettled per id, not Promise.all, so one bad id
// never fails get_movies/get_tv_shows' whole call.
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

// Used directly by search_people (whose /search/person response carries no
// media_type at all) and by summarizeMultiItem's "person" case below.
export function summarizePerson(item: TmdbMultiItem): z.infer<typeof personSummarySchema> {
  return personSummarySchema.parse({
    id: item.id,
    media_type: "person",
    name: item.name,
    known_for_department: item.known_for_department || null,
    popularity: item.popularity ?? null,
    profile_url: imageUrl(item.profile_path),
    known_for: (item.known_for ?? [])
      .map((k) => k.title || k.name)
      .filter(Boolean)
      .slice(0, 5),
  });
}

// Trending / multi-search dispatch by media_type; people carry known_for titles.
// Each branch delegates to a shaper that already validates its own output, so
// there's no separate schema for the dispatcher itself.
export function summarizeMultiItem(item: TmdbMultiItem): z.infer<typeof multiItemSchema> {
  switch (item.media_type) {
    case "tv":
      return summarizeTv(item);
    case "person":
      return summarizePerson(item);
    case "movie":
    default:
      // Multi-search omits media_type on some rows; title vs name disambiguates.
      return item.title !== undefined ? summarizeMovie(item) : summarizeTv(item);
  }
}

// A type alias (not an interface): TS only synthesizes an index signature for
// assignability against `Record<string, unknown>` — the shape tools/*.ts's
// jsonResult() wire-serialization boundary expects — on anonymous object
// types, not named interfaces. Confirmed empirically; see the fix that
// replaced this interface with the identical-shape alias below.
export type Page<S> = {
  results: S[];
  page: number;
  total_pages: number;
  total_results: number;
};

// Generic page wrapper reused by every list endpoint; not tied to one shaper,
// so not schema-validated here — `summarize` already validates each item, and
// the wrapper's own shape (results/page/total_pages/total_results) is simple
// enough that the tool-registration-site `pageSchema(itemSchema)` plus the
// real MCP client-side outputSchema check are sufficient coverage for it.
export function page<T, S>(res: TmdbPage<T>, summarize: (item: T) => S): Page<S> {
  return {
    results: (res.results ?? []).map(summarize),
    page: res.page ?? 1,
    total_pages: res.total_pages ?? 1,
    total_results: res.total_results ?? res.results?.length ?? 0,
  };
}

export function summarizeGenres(genres: NamedRef[]): z.infer<typeof genresSchema> {
  return genresSchema.parse({ genres: genres.map((g) => ({ id: g.id, name: g.name })) });
}

export interface TmdbReview {
  author?: string;
  author_details?: { rating?: number | null; username?: string };
  content?: string;
  created_at?: string;
  url?: string;
}

// A user review — author, their 0–10 rating (if any), date, and the body
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

export interface TmdbCollection {
  id?: number;
  name?: string;
  overview?: string;
  poster_path?: string | null;
  parts?: TmdbMovie[];
}

// A movie collection/franchise and its parts, ordered chronologically.
export function summarizeCollection(c: TmdbCollection): z.infer<typeof collectionSchema> {
  const parts = (c.parts ?? [])
    .slice()
    .sort((a, b) => (a.release_date || "").localeCompare(b.release_date || ""));
  return collectionSchema.parse({
    id: c.id,
    name: c.name,
    overview: c.overview || null,
    poster_url: imageUrl(c.poster_path),
    parts: parts.map(summarizeMovie),
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
  return keywordsSchema.parse({
    results: (r.results ?? []).map((k) => ({ id: k.id, name: k.name })),
    page: r.page ?? 1,
    total_pages: r.total_pages ?? 1,
    total_results: r.total_results ?? r.results?.length ?? 0,
  });
}

// ---- watch providers --------------------------------------------------------

interface ProviderEntry {
  provider_id?: number;
  provider_name?: string;
  logo_path?: string | null;
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
  return (list ?? []).map((p) => p.provider_name).filter((n): n is string => Boolean(n));
}

// Watch availability is region-specific (JustWatch data). We surface one region
// (the caller's) plus the list of regions that have data, so the agent can retry.
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
  popularity?: number;
}
export interface CombinedCredits {
  cast?: CombinedCreditEntry[];
  crew?: CombinedCreditEntry[];
}

function creditTitle(e: CombinedCreditEntry): string | undefined {
  return e.title ?? e.name;
}
function creditYear(e: CombinedCreditEntry): number | null {
  return year(e.release_date ?? e.first_air_date);
}

// TMDB's per-credit `popularity` is the linked title's own entity-level score,
// not a measure of the role — a long-running talk show accumulates a far
// higher popularity than any single film, so unfiltered "Self" guest spots
// (Letterman, Kimmel, awards-show cameos, …) crowd out an actor's actual,
// much more relevant film/TV roles. Excluded so the ranked list is about roles.
const isSelfAppearance = (e: CombinedCreditEntry): boolean =>
  /^(self|himself|herself)\b/i.test(e.character ?? "");

// Repeat guest spots (or a title credited under more than one character/job)
// otherwise waste multiple of the capped slots on the same title.
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

// A prolific person can have hundreds of credits; cap to the most popular so the
// result stays useful and token-bounded.
export function summarizePersonCredits(
  c: CombinedCredits,
  limit = 25,
): z.infer<typeof personCreditsSchema> {
  const byPopularity = (a: CombinedCreditEntry, b: CombinedCreditEntry): number =>
    (b.popularity ?? 0) - (a.popularity ?? 0);
  const cast = dedupeByKey(
    (c.cast ?? []).filter((e) => !isSelfAppearance(e)).sort(byPopularity),
    (e) => e.id?.toString(),
  )
    .slice(0, limit)
    .map((e) => ({
      id: e.id,
      media_type: e.media_type,
      title: creditTitle(e),
      year: creditYear(e),
      character: e.character || null,
      vote_average: e.vote_average ?? null,
    }));
  const crew = dedupeByKey((c.crew ?? []).slice().sort(byPopularity), (e) =>
    e.id !== undefined && e.job ? `${e.id}:${e.job}` : undefined,
  )
    .slice(0, limit)
    .map((e) => ({
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
    type: v.type || null,
    site: v.site || null,
    official: v.official ?? null,
    url: v.site === "YouTube" && v.key ? `https://www.youtube.com/watch?v=${v.key}` : null,
    published_at: v.published_at || null,
  }));
  return videosSchema.parse({ results });
}

// ---- find by external id ----------------------------------------------------

export interface FindResponse {
  movie_results?: TmdbMovie[];
  tv_results?: TmdbTv[];
  person_results?: TmdbPerson[];
  tv_episode_results?: unknown[];
  tv_season_results?: unknown[];
}

export function summarizeFind(r: FindResponse): z.infer<typeof findSchema> {
  return findSchema.parse({
    movie_results: (r.movie_results ?? []).map(summarizeMovie),
    tv_results: (r.tv_results ?? []).map(summarizeTv),
    person_results: (r.person_results ?? []).map((p) => ({
      id: p.id,
      media_type: "person",
      name: p.name,
      known_for_department: p.known_for_department || null,
      profile_url: imageUrl(p.profile_path),
    })),
  });
}

// ---- TV season & episode ----------------------------------------------------

interface RawEpisode {
  episode_number?: number;
  name?: string;
  overview?: string;
  air_date?: string | null;
  runtime?: number | null;
  vote_average?: number;
  still_path?: string | null;
  guest_stars?: { id?: number; name?: string; character?: string }[];
  crew?: { id?: number; name?: string; job?: string }[];
}
export interface TmdbSeason {
  id?: number;
  name?: string;
  season_number?: number;
  air_date?: string | null;
  overview?: string;
  poster_path?: string | null;
  episodes?: RawEpisode[];
}

// `episodeLimit` caps "Specials" seasons that accumulate hundreds of bonus/promo
// clips over a long-running show's lifetime (e.g. 300+ for some long-running
// series) and would otherwise blow well past a reasonable response size.
// `episode_count` still reports the true total; `episodes` is the capped list.
export function summarizeSeason(s: TmdbSeason, episodeLimit = 50): z.infer<typeof seasonSchema> {
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
      runtime_minutes: e.runtime ?? null,
      vote_average: e.vote_average ?? null,
      overview: e.overview || null,
    })),
  });
}

export function summarizeEpisode(
  e: RawEpisode & { season_number?: number },
): z.infer<typeof episodeSchema> {
  return episodeSchema.parse({
    season_number: e.season_number ?? null,
    episode_number: e.episode_number ?? null,
    name: e.name || null,
    air_date: e.air_date || null,
    runtime_minutes: e.runtime ?? null,
    vote_average: e.vote_average ?? null,
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

// `notFoundOk: true` (the default) returns a soft { found: false } object
// instead of throwing, so enrichment never fails a TMDB lookup.
export function summarizeRatings(r: OmdbResponse): z.infer<typeof ratingsSchema> {
  if (r.Response === "False") {
    return ratingsSchema.parse({ found: false, reason: r.Error || "No OMDb match" });
  }
  const ratings = (r.Ratings ?? []).map((x) => ({ source: x.Source, value: x.Value }));
  const rt = ratings.find((x) => x.source === "Rotten Tomatoes")?.value || null;
  return ratingsSchema.parse({
    found: true,
    imdb_id: r.imdbID || null,
    title: r.Title || null,
    year: r.Year || null,
    rated: r.Rated && r.Rated !== "N/A" ? r.Rated : null,
    runtime: r.Runtime && r.Runtime !== "N/A" ? r.Runtime : null,
    imdb_rating: r.imdbRating && r.imdbRating !== "N/A" ? r.imdbRating : null,
    imdb_votes: r.imdbVotes && r.imdbVotes !== "N/A" ? r.imdbVotes : null,
    metascore: r.Metascore && r.Metascore !== "N/A" ? r.Metascore : null,
    rotten_tomatoes: rt,
    awards: r.Awards && r.Awards !== "N/A" ? r.Awards : null,
    ratings,
  });
}
