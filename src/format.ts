// Trims verbose TMDB/OMDb payloads down to the fields an agent actually needs,
// keeping tool responses token-efficient. List endpoints get compact summaries;
// the get_* detail shapers keep the longer fields (overview, credits, etc.).
// Clients fetch + cache; all raw→agent-facing shaping lives here.

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
  external_ids?: { imdb_id?: string | null };
  // Appended via append_to_response=content_ratings.
  content_ratings?: { results?: { iso_3166_1?: string; rating?: string }[] };
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

export function summarizeMovie(m: TmdbMovie): Record<string, unknown> {
  return {
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
  };
}

export function detailMovie(m: TmdbMovie, region = "US"): Record<string, unknown> {
  const certifications = movieCertifications(m);
  return {
    id: m.id,
    imdb_id: m.imdb_id ?? null,
    media_type: "movie",
    // Age/content rating for `region` (e.g. MPAA "PG-13"); full map below.
    certification: certifications[region] ?? null,
    certification_region: region,
    certifications,
    title: m.title,
    original_title: m.original_title,
    tagline: m.tagline || null,
    overview: m.overview || null,
    year: year(m.release_date),
    release_date: m.release_date || null,
    runtime_minutes: m.runtime ?? null,
    status: m.status ?? null,
    genres: names(m.genres),
    vote_average: m.vote_average ?? null,
    vote_count: m.vote_count ?? null,
    popularity: m.popularity ?? null,
    original_language: m.original_language ?? null,
    spoken_languages: (m.spoken_languages ?? [])
      .map((l) => l.english_name || l.name)
      .filter(Boolean),
    production_companies: names(m.production_companies),
    budget_usd: m.budget || null,
    revenue_usd: m.revenue || null,
    homepage: m.homepage || null,
    poster_url: imageUrl(m.poster_path),
    // tmdb_url is handy for users who want the canonical web page.
    tmdb_url: `https://www.themoviedb.org/movie/${m.id}`,
    imdb_url: m.imdb_id ? `https://www.imdb.com/title/${m.imdb_id}/` : null,
  };
}

export function summarizeTv(t: TmdbTv): Record<string, unknown> {
  return {
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
  };
}

export function detailTv(t: TmdbTv, region = "US"): Record<string, unknown> {
  const certifications = tvCertifications(t);
  return {
    id: t.id,
    imdb_id: t.external_ids?.imdb_id ?? null,
    media_type: "tv",
    // Age/content rating for `region` (e.g. "TV-MA"); full map below.
    certification: certifications[region] ?? null,
    certification_region: region,
    certifications,
    name: t.name,
    original_name: t.original_name,
    tagline: t.tagline || null,
    overview: t.overview || null,
    first_air_date: t.first_air_date || null,
    last_air_date: t.last_air_date || null,
    status: t.status ?? null,
    in_production: t.in_production ?? null,
    number_of_seasons: t.number_of_seasons ?? null,
    number_of_episodes: t.number_of_episodes ?? null,
    episode_run_time: t.episode_run_time ?? [],
    genres: names(t.genres),
    vote_average: t.vote_average ?? null,
    vote_count: t.vote_count ?? null,
    popularity: t.popularity ?? null,
    original_language: t.original_language ?? null,
    networks: names(t.networks),
    created_by: names(t.created_by),
    poster_url: imageUrl(t.poster_path),
    tmdb_url: `https://www.themoviedb.org/tv/${t.id}`,
    imdb_url: t.external_ids?.imdb_id
      ? `https://www.imdb.com/title/${t.external_ids.imdb_id}/`
      : null,
  };
}

export function detailPerson(p: TmdbPerson): Record<string, unknown> {
  return {
    id: p.id,
    imdb_id: p.imdb_id ?? null,
    name: p.name,
    also_known_as: p.also_known_as ?? [],
    known_for_department: p.known_for_department ?? null,
    gender: genderLabel(p.gender),
    biography: p.biography || null,
    birthday: p.birthday ?? null,
    deathday: p.deathday ?? null,
    place_of_birth: p.place_of_birth ?? null,
    popularity: p.popularity ?? null,
    homepage: p.homepage || null,
    profile_url: imageUrl(p.profile_path),
    tmdb_url: `https://www.themoviedb.org/person/${p.id}`,
    imdb_url: p.imdb_id ? `https://www.imdb.com/name/${p.imdb_id}/` : null,
  };
}

// `castLimit` caps the long tail of bit-part actors that bloats credits.
export function summarizeCredits(c: TmdbCredits, castLimit = 20): Record<string, unknown> {
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
  return { cast, crew };
}

// Trending / multi-search dispatch by media_type; people carry known_for titles.
export function summarizeMultiItem(item: TmdbMultiItem): Record<string, unknown> {
  switch (item.media_type) {
    case "tv":
      return summarizeTv(item as TmdbTv);
    case "person":
      return {
        id: item.id,
        media_type: "person",
        name: item.name,
        known_for_department: item.known_for_department ?? null,
        popularity: item.popularity ?? null,
        profile_url: imageUrl(item.profile_path),
        known_for: (item.known_for ?? [])
          .map((k) => k.title || k.name)
          .filter(Boolean)
          .slice(0, 5),
      };
    case "movie":
    default:
      // Multi-search omits media_type on some rows; title vs name disambiguates.
      return item.title !== undefined ? summarizeMovie(item as TmdbMovie) : summarizeTv(item);
  }
}

export function page<T, S>(res: TmdbPage<T>, summarize: (item: T) => S): Record<string, unknown> {
  return {
    results: (res.results ?? []).map(summarize),
    page: res.page ?? 1,
    total_pages: res.total_pages ?? 1,
    total_results: res.total_results ?? res.results?.length ?? 0,
  };
}

export function summarizeGenres(genres: NamedRef[]): Record<string, unknown> {
  return { genres: genres.map((g) => ({ id: g.id, name: g.name })) };
}

export interface KeywordsResponse {
  results?: { id?: number; name?: string }[];
  page?: number;
  total_pages?: number;
  total_results?: number;
}

// Keyword ids feed discover_*'s `with_keywords`/`without_keywords` filters.
export function summarizeKeywords(r: KeywordsResponse): Record<string, unknown> {
  return {
    results: (r.results ?? []).map((k) => ({ id: k.id, name: k.name })),
    page: r.page ?? 1,
    total_pages: r.total_pages ?? 1,
    total_results: r.total_results ?? r.results?.length ?? 0,
  };
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
): Record<string, unknown> {
  const all = r.results ?? {};
  const regions = Object.keys(all).sort();
  const here = all[region];
  if (!here) {
    return { region, available: false, available_regions: regions };
  }
  return {
    region,
    available: true,
    link: here.link ?? null,
    streaming: providerNames(here.flatrate),
    free: providerNames(here.free),
    ads: providerNames(here.ads),
    rent: providerNames(here.rent),
    buy: providerNames(here.buy),
    available_regions: regions,
  };
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

// A prolific person can have hundreds of credits; cap to the most popular so the
// result stays useful and token-bounded.
export function summarizePersonCredits(c: CombinedCredits, limit = 25): Record<string, unknown> {
  const byPopularity = (a: CombinedCreditEntry, b: CombinedCreditEntry): number =>
    (b.popularity ?? 0) - (a.popularity ?? 0);
  const cast = (c.cast ?? [])
    .slice()
    .sort(byPopularity)
    .slice(0, limit)
    .map((e) => ({
      id: e.id,
      media_type: e.media_type,
      title: creditTitle(e),
      year: creditYear(e),
      character: e.character || null,
      vote_average: e.vote_average ?? null,
    }));
  const crew = (c.crew ?? [])
    .slice()
    .sort(byPopularity)
    .slice(0, limit)
    .map((e) => ({
      id: e.id,
      media_type: e.media_type,
      title: creditTitle(e),
      year: creditYear(e),
      job: e.job || null,
      department: e.department || null,
    }));
  return { cast, crew };
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
export function summarizeVideos(r: VideosResponse): Record<string, unknown> {
  const results = (r.results ?? []).map((v) => ({
    name: v.name,
    type: v.type ?? null,
    site: v.site ?? null,
    official: v.official ?? null,
    url: v.site === "YouTube" && v.key ? `https://www.youtube.com/watch?v=${v.key}` : null,
    published_at: v.published_at ?? null,
  }));
  return { results };
}

// ---- find by external id ----------------------------------------------------

export interface FindResponse {
  movie_results?: TmdbMovie[];
  tv_results?: TmdbTv[];
  person_results?: TmdbPerson[];
  tv_episode_results?: unknown[];
  tv_season_results?: unknown[];
}

export function summarizeFind(r: FindResponse): Record<string, unknown> {
  return {
    movie_results: (r.movie_results ?? []).map(summarizeMovie),
    tv_results: (r.tv_results ?? []).map(summarizeTv),
    person_results: (r.person_results ?? []).map((p) => ({
      id: p.id,
      media_type: "person",
      name: p.name,
      known_for_department: p.known_for_department ?? null,
      profile_url: imageUrl(p.profile_path),
    })),
  };
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

export function summarizeSeason(s: TmdbSeason): Record<string, unknown> {
  return {
    season_number: s.season_number ?? null,
    name: s.name ?? null,
    air_date: s.air_date ?? null,
    overview: s.overview || null,
    poster_url: imageUrl(s.poster_path),
    episode_count: s.episodes?.length ?? 0,
    episodes: (s.episodes ?? []).map((e) => ({
      episode_number: e.episode_number ?? null,
      name: e.name ?? null,
      air_date: e.air_date ?? null,
      runtime_minutes: e.runtime ?? null,
      vote_average: e.vote_average ?? null,
      overview: e.overview || null,
    })),
  };
}

export function summarizeEpisode(
  e: RawEpisode & { season_number?: number },
): Record<string, unknown> {
  return {
    season_number: e.season_number ?? null,
    episode_number: e.episode_number ?? null,
    name: e.name ?? null,
    air_date: e.air_date ?? null,
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
  };
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
export function summarizeRatings(r: OmdbResponse): Record<string, unknown> {
  if (r.Response === "False") {
    return { found: false, reason: r.Error ?? "No OMDb match" };
  }
  const ratings = (r.Ratings ?? []).map((x) => ({ source: x.Source, value: x.Value }));
  const rt = ratings.find((x) => x.source === "Rotten Tomatoes")?.value ?? null;
  return {
    found: true,
    imdb_id: r.imdbID ?? null,
    title: r.Title ?? null,
    year: r.Year ?? null,
    rated: r.Rated && r.Rated !== "N/A" ? r.Rated : null,
    runtime: r.Runtime && r.Runtime !== "N/A" ? r.Runtime : null,
    imdb_rating: r.imdbRating && r.imdbRating !== "N/A" ? r.imdbRating : null,
    imdb_votes: r.imdbVotes && r.imdbVotes !== "N/A" ? r.imdbVotes : null,
    metascore: r.Metascore && r.Metascore !== "N/A" ? r.Metascore : null,
    rotten_tomatoes: rt,
    awards: r.Awards && r.Awards !== "N/A" ? r.Awards : null,
    ratings,
  };
}
