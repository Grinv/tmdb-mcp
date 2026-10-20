// Finding titles by criteria rather than a known id/title: get_trending
// (what's popular right now), get_movie_releases (in cinemas now / soon),
// get_movie_genres/get_tv_genres (reference data feeding
// with_genres/without_genres below), and discover_movies/discover_tv
// (the actual structured-filter search). TV_TYPES/TV_STATUSES/DiscoverParams/
// discoverParamsSchema are exported for clients/tmdb.ts's discoverQuery — see
// AGENTS.md's Conventions section for why that's a lower-layer file type-
// importing from this higher-layer one (intentional, erased at build).
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  genresSchema,
  movieSummarySchema,
  movieReleasesSchema,
  multiItemSchema,
  pageSchema,
  tvSummarySchema,
} from "../../format.schemas.js";
import { READ_ONLY } from "../shared.js";
import {
  includeAdult,
  language,
  page,
  watchRegion,
  yearFilter,
  type TmdbToolDeps,
} from "./fields.js";

const SHARED_SORT_FIELDS = ["popularity", "vote_average", "vote_count"] as const;
const MOVIE_SORT_BY = [
  ...SHARED_SORT_FIELDS.flatMap((f) => [`${f}.asc`, `${f}.desc`] as const),
  "original_title.asc",
  "original_title.desc",
  "primary_release_date.asc",
  "primary_release_date.desc",
  "revenue.asc",
  "revenue.desc",
] as const;
const TV_SORT_BY = [
  ...SHARED_SORT_FIELDS.flatMap((f) => [`${f}.asc`, `${f}.desc`] as const),
  "name.asc",
  "name.desc",
  "first_air_date.asc",
  "first_air_date.desc",
] as const;
// Every discover id-list filter (with_genres, with_companies, with_cast, …) is
// a comma-separated list of numeric TMDB ids. Verified live: TMDB does not
// error on an unparseable id, it matches nothing — with_genres="action",
// with_companies="pixar" and with_watch_providers="netflix" each come back
// total_results:0, indistinguishable from a filter that legitimately found
// nothing. A stray genre name or typo therefore reads as a real empty answer,
// which is worse than a loud failure — so reject non-numeric input here
// instead (mirrors with_original_language's own regex guard below).
// TMDB's watch-offer access models (the same flatrate/rent/buy/ads/free keys
// get_watch_providers reports per region).
const WATCH_MONETIZATION_TYPES = ["flatrate", "free", "ads", "rent", "buy"] as const;
// TMDB's release types (its numeric codes 1-6, in this order), exported for
// clients/tmdb.ts's discoverQuery to translate the name into that code.
export const RELEASE_TYPES = [
  "premiere",
  "theatrical_limited",
  "theatrical",
  "digital",
  "physical",
  "tv",
] as const;
const idListRegex = /^\d+(?:,\d+)*$/;
const idList = (desc: string) =>
  z
    .string()
    .regex(idListRegex, 'Expected comma-separated numeric TMDB ids, e.g. "28,12".')
    .describe(desc)
    .optional();
// with_* filters: TMDB reads "," as AND and "|" as OR (verified live on
// /discover/movie: Netflix=8 → 54, Prime=9 → 19, "8,9" → 0, "8|9" → 73; same
// for with_cast, with_genres, with_networks). One separator per value — a mix
// is rejected rather than guessed at.
const idMatchRegex = /^\d+(?:(?:,\d+)*|(?:\|\d+)*)$/;
const ID_MATCH_HINT =
  ' Join several ids with "," to require ALL of them, or "|" to match ANY (e.g. "8|9").';
const idMatch = (desc: string) =>
  z
    .string()
    .regex(
      idMatchRegex,
      'Expected numeric TMDB ids joined by "," (all) or "|" (any), e.g. "28,12".',
    )
    .describe(desc + ID_MATCH_HINT)
    .optional();
const withGenres = idMatch("TMDB genre ids; get them from get_movie_genres/get_tv_genres.");
// TMDB's with_original_language discover filter, unlike `language` above,
// takes a plain ISO-639-1 code with no region suffix.
const originalLanguageRegex = /^[a-z]{2}$/;
const dateStr = (what: string) => z.iso.date().describe(what).optional();
const discoverShared = {
  with_genres: withGenres,
  without_genres: idList(
    "Comma-separated TMDB genre ids to exclude; get ids from get_movie_genres/get_tv_genres.",
  ),
  year: yearFilter("Release / first-air year."),
  release_date_gte: dateStr(
    "Only entries released on/after this date (YYYY-MM-DD). Must be <= release_date_lte if " +
      "both are given.",
  ),
  release_date_lte: dateStr("Only entries released on/before this date (YYYY-MM-DD)."),
  min_rating: z
    .number()
    .min(0)
    .max(10)
    .describe("Minimum TMDB vote average (0-10). Must be <= max_rating if both are given.")
    .optional(),
  max_rating: z.number().min(0).max(10).describe("Maximum TMDB vote average (0-10).").optional(),
  min_votes: z.int().min(0).describe("Minimum vote count (filters obscure titles).").optional(),
  min_runtime: z
    .int()
    .min(0)
    .describe("Minimum runtime in minutes. Must be <= max_runtime if both are given.")
    .optional(),
  max_runtime: z.int().min(0).describe("Maximum runtime in minutes.").optional(),
  with_original_language: z
    .string()
    .regex(
      originalLanguageRegex,
      "Use a plain ISO-639-1 language code with no region, e.g. 'en' or 'ja'.",
    )
    .describe("ISO-639-1 original-language code, e.g. 'en', 'ja'.")
    .optional(),
  // Verified live (/discover/movie, primary_release_year=2019 → 20001): with_origin_country
  // KR → 725, JP → 1573, "KR|JP" → 2295 (OR) vs "KR,JP" → 3 (AND: co-productions
  // only), hence the "|" join in discoverQuery; lowercase "kr" → 725 too; an
  // unknown code ("ZZ") → 0. /discover/tv (first_air_date_year=2019 → 8942):
  // KR → 563, JP → 534, "KR|JP" → 1097.
  with_origin_country: z
    .array(z.string().regex(/^[A-Z]{2}$/, "Use a two-letter ISO-3166-1 country code, e.g. 'KR'."))
    .min(1)
    .describe(
      "Only titles whose country of origin (where they were produced, not where they can be " +
        "watched) is one of these ISO-3166-1 codes, e.g. ['KR'] for Korean titles; several " +
        "codes match ANY of them. An unknown code matches nothing.",
    )
    .optional(),
  with_companies: idMatch(
    "TMDB production company ids (use search_companies to resolve names → ids).",
  ),
  // Verified live (/discover/movie, primary_release_year=2019&vote_count.gte=1000
  // → 186; Marvel=420 has 3, Disney=2 has 6): without_companies=420 → 183,
  // =2 → 180, "420,2" → 177 (drops either). /discover/tv
  // (first_air_date.gte=2015-01-01&vote_count.gte=200 → 1514; company 1957 has
  // 67) → 1447.
  without_companies: idList(
    "Comma-separated TMDB production company ids to exclude: titles produced by ANY of them " +
      "are dropped (use search_companies to resolve names → ids).",
  ),
  with_keywords: idMatch("TMDB keyword ids (use search_keywords to resolve names → ids)."),
  without_keywords: idList(
    "Comma-separated TMDB keyword ids to exclude (use search_keywords to resolve names → ids).",
  ),
  with_watch_providers: idMatch(
    "TMDB watch-provider ids (use search_watch_providers to resolve a " +
      "service name, e.g. 'Netflix', to its numeric id); requires watch_region to also be set.",
  ),
  // Verified live (/discover/movie, primary_release_year=2019&vote_count.gte=1000
  // → 186; Netflix=8 in US → 54, "8|337" → 68): without_watch_providers=8 +
  // watch_region=US → 132, "8,337" → 118 (drops either); without watch_region
  // it is a silent no-op (186). /discover/tv
  // (first_air_date.gte=2015-01-01&vote_count.gte=200 → 1514, Netflix US 585)
  // → 929.
  without_watch_providers: idList(
    "Comma-separated TMDB watch-provider ids to exclude: titles that ANY of them offers in " +
      "watch_region are dropped, e.g. 'not on Netflix' (use search_watch_providers to resolve a " +
      "service name to its id); requires watch_region to also be set.",
  ),
  // Verified live (/discover/movie, primary_release_year=2019, watch_region=US):
  // with_watch_providers=2 alone → 2888; +flatrate → 1811; +rent → 2841;
  // "flatrate|rent" → 2852 (OR) vs "flatrate,rent" → 1800 (AND), hence the
  // "|" join in discoverQuery. Without any providers it still filters
  // (watch_region=US + flatrate → 4237 of 20001), but without watch_region it
  // is a silent no-op (20001, same as unfiltered). With providers set, TMDB
  // ANDs the two filters independently: every top result of providers=2 +
  // flatrate had provider 2 only under rent/buy and flatrate elsewhere.
  with_watch_monetization_types: z
    .array(z.enum(WATCH_MONETIZATION_TYPES))
    .min(1)
    .describe(
      "Only titles available in watch_region through at least one of these access models: " +
        "'flatrate' = included in a subscription (e.g. Netflix), 'free' = free to watch, 'ads' = " +
        "free with ads, 'rent' = paid rental, 'buy' = paid purchase. Several values match ANY " +
        "of them. Requires watch_region; works alone (any provider). Combined with " +
        "with_watch_providers, TMDB checks the two independently, not per provider: " +
        "with_watch_providers=2 (Apple TV, rent/buy only) + 'flatrate' still matches titles " +
        "rentable on Apple TV that some OTHER service streams — check get_watch_providers to " +
        "confirm which service offers which access model.",
    )
    .optional(),
  watch_region: watchRegion
    .describe(
      "Two-letter ISO-3166-1 country code, e.g. 'US', whose streaming catalog " +
        "with_watch_providers / without_watch_providers / with_watch_monetization_types filter " +
        "on. Only valid together with at least one of them.",
    )
    .optional(),
  // Shared, not movie-only: verified live against the real /discover/tv (not
  // just /discover/movie) — an unsupported/nonsense certification value
  // returns zero results there too, confirming TMDB actually applies it
  // rather than silently ignoring an undocumented param.
  //
  // The opposite case — an unrecognized certification_country — is a silent
  // no-op instead: verified live against /discover/movie, pairing a real
  // certification ("PG-13") with a nonsense certification_country ("ZZ")
  // returned a total_results count matching the fully-unfiltered call
  // (~1.16M either way), not the ~10K a real US-certification-country filter
  // returns, confirming the filter is disabled rather than applied-and-empty.
  //
  // "|" is OR, verified live (US, primary_release_year=2019): G → 161, PG → 293,
  // "G|PG" → 454 (also "g|pg"); "G,PG" → 0; an unknown member is just dropped
  // ("G|PG13" → 161). TMDB's certification.lte is deliberately NOT exposed: it
  // compares by the rating's `order`, where the US's "NR" (unrated) is 0, so
  // lte=G → 1251 (161 G + ~1091 NR) and an unknown value ("PG13") silently
  // turns into "any rated title" (2359, same as lte=NC-17) — the "|" list is
  // the predictable way to ask for "PG or below".
  certification: z
    .string()
    .regex(/\S/, "certification must not be blank.")
    .describe(
      "Filter by exact age/content certification, e.g. 'PG-13' (movies) or 'TV-Y7' (TV); join " +
        "several with '|' to match ANY of them, e.g. 'G|PG' for kids/family movies or " +
        "'TV-Y|TV-Y7|TV-G' for kids' TV. Requires " +
        "certification_country, and a certification_country TMDB doesn't recognize silently " +
        "disables this filter (returns unfiltered results) instead of erroring or matching nothing " +
        "— double-check the country actually has data for that rating system. Matching is " +
        "case-insensitive (verified live: 'pg-13' and 'PG-13' return identical results) but must " +
        "otherwise exactly match one of TMDB's known rating strings for that country's system, " +
        "punctuation included (e.g. 'PG-13', not 'PG13'). Unlike get_movie/get_tv's own certification " +
        "field (which falls back to the US rating, then any country, when the requested region has " +
        "none), this filter has NO fallback: a title with no certification entry at all for the " +
        "exact country given is silently excluded from results, even if it's certified elsewhere " +
        "(e.g. has a US rating) — for a country with sparse TMDB certification data, prefer " +
        "certification_country='US' for broader, more reliable coverage over the user's actual " +
        "country if completeness matters more than exact local ratings.",
    )
    .optional(),
  certification_country: z
    .string()
    .regex(/^[A-Z]{2}$/, "Two-letter ISO-3166-1 country code.")
    .describe(
      "Country whose certification system the `certification` filter uses, e.g. 'US'. Only " +
        "valid together with certification.",
    )
    .optional(),
  language,
  // Verified live against both /discover/movie and /discover/tv: unlike
  // region below, this measurably changes the result set on both endpoints
  // (a five/six-figure swing in total_results with no other filters at all).
  include_adult: includeAdult,
  page: page.optional(),
};

// Movie discover adds cast/crew/people filters.
const discoverMovieSchema = {
  ...discoverShared,
  sort_by: z
    .enum(MOVIE_SORT_BY)
    .describe("Sort order. Defaults to TMDB's own default (roughly popularity-based) if omitted.")
    .optional(),
  with_cast: idMatch(
    "TMDB person ids, restricted to cast (actor) roles. Use search_people to " +
      "resolve an actor's name to their id.",
  ),
  with_crew: idMatch(
    "TMDB person ids, restricted to crew roles (e.g. a director). Use " +
      "search_people to resolve a name to their id.",
  ),
  with_people: idMatch(
    "TMDB person ids, matching either a cast or crew role. Use search_people " +
      "to resolve a name to their id.",
  ),
  // TMDB's release_date.gte/lte (NOT primary_release_date, which
  // release_date_gte/lte above map to): matches a movie with ANY single
  // release — any country, any type, re-releases included — in the window.
  // Verified live: release_date 2026-09-01..30 → 7895 vs primary_release_date
  // → 4364; + region=DE → 473, US → 1504, ZZ → 0; + with_release_type=3 → 1566,
  // + region=DE → 95, every top-10 result checked had a DE type-3 release in
  // the window (incl. 299534 Avengers: Endgame and 920 Cars, re-released
  // there, whose rows still carry their original release_date 2019-04-24 /
  // 2006-09-07). One bound alone works (release_date.lte=2000-01-01 at
  // vote_count.gte=5000: 204, + region=DE 195, + with_release_type=3 193).
  // Inverted range → 0, so it's rejected like release_date_gte/lte.
  any_release_date_gte: dateStr(
    "Only movies with at least one release (any country and release type, re-releases " +
      "included) on/after this date (YYYY-MM-DD) — unlike release_date_gte, which uses each " +
      "movie's original premiere date. Narrow it with region and with_release_type, e.g. " +
      "region='DE' + with_release_type=['theatrical'] + this window = movies in German cinemas " +
      "then. A re-released movie matches, but its row's release_date stays the original one. " +
      "Must be <= any_release_date_lte if both are given.",
  ),
  any_release_date_lte: dateStr(
    "Only movies with at least one release (see any_release_date_gte) on/before this date " +
      "(YYYY-MM-DD).",
  ),
  // Verified live (release_date 2026-09-01..30, region=DE): theatrical (3) →
  // 95, theatrical_limited (2) → 13, "2|3" → 107 (OR; "2,3" → 259, matching
  // neither AND nor OR, hence the "|" join in discoverQuery), digital (4) →
  // 110. Without any_release_date_gte/lte it is a silent no-op (vote_count.gte=5000:
  // 1083 with and without with_release_type=3 or 6, with or without region=DE).
  with_release_type: z
    .array(z.enum(RELEASE_TYPES))
    .min(1)
    .describe(
      "Only count releases of these types toward any_release_date_gte/lte (and region): " +
        "'premiere', 'theatrical_limited', 'theatrical' (wide cinema release), 'digital' (VOD/" +
        "streaming), 'physical' (DVD/Blu-ray), 'tv' (TV broadcast). Several values match ANY of " +
        "them. Requires any_release_date_gte or any_release_date_lte.",
    )
    .optional(),
  // Verified live: only any_release_date_gte/lte reads it (see the comment
  // above them). With neither set it is a silent no-op — vote_count.gte=5000
  // gives 1083 with and without region=DE, and the same holds alongside year
  // or release_date_gte/lte (primary release date). Rejected in that case
  // instead. Movie-only: /discover/tv first_air_date_year=2019 gives 8942 with
  // and without region=DE.
  // Deliberately NOT built via the shared regionSchema(defaultRegion) factory:
  // that factory's description asserts a "(default 'XXX')" fallback, but
  // discoverQuery (clients/tmdb.ts) never defaults this to config.tmdbRegion
  // the way getMovie/getTv/getWatchProviders do — it's a pure pass-through,
  // omitted entirely from the query when not given.
  region: z
    .string()
    .regex(/^[A-Z]{2}$/, "Use a two-letter ISO-3166-1 country code, e.g. 'US'.")
    .describe(
      "ISO-3166-1 country code: limits any_release_date_gte/lte (and with_release_type) to " +
        "releases in this country, e.g. 'DE'. Requires any_release_date_gte or " +
        "any_release_date_lte; it has no effect on year/release_date_gte/lte. An unknown code " +
        "matches nothing. Movie-only.",
    )
    .optional(),
};

// TMDB's own fixed vocabularies for a TV show's type/status (verified live
// against the real /discover/tv query values — not something tmdb-mcp
// invents). Exported so clients/tmdb.ts's discoverQuery can translate the
// human-readable name this schema asks for into the numeric code TMDB's
// query actually expects.
export const TV_TYPES = [
  "Documentary",
  "News",
  "Miniseries",
  "Reality",
  "Scripted",
  "Talk Show",
  "Video",
] as const;
export const TV_STATUSES = [
  "Returning Series",
  "Planned",
  "In Production",
  "Ended",
  "Cancelled",
  "Pilot",
] as const;

// TV discover adds network/type/status filtering. Deliberately no with_cast/
// with_crew/with_people here (unlike discoverMovieSchema above): verified live
// via a raw request straight to TMDB's /discover/tv that it silently ignores
// those params rather than erroring (identical total_results with vs. without
// with_cast set) — rejecting them at our own schema (a validation error) is
// strictly more useful than forwarding a param TMDB would just no-op on.
const discoverTvSchema = {
  ...discoverShared,
  sort_by: z
    .enum(TV_SORT_BY)
    .describe(
      "Sort order. Defaults to TMDB's own default (roughly popularity-based) if omitted. TV's " +
        "vocabulary differs from discover_movies' — 'name'/'first_air_date' instead of " +
        "'original_title'/'primary_release_date', and no 'revenue' (TMDB doesn't track it per-show).",
    )
    .optional(),
  with_networks: idMatch(
    "TMDB TV network ids, e.g. HBO=49, Netflix=213 (verified live). Unlike " +
      "with_companies/with_keywords/with_people, this server has no name-based resolver for " +
      "networks — supply the raw TMDB network id directly; a well-known network's id may " +
      "already be known, otherwise there's no in-server way to look one up.",
  ),
  with_type: z
    .enum(TV_TYPES)
    .describe(
      "Restrict to this TV type — e.g. 'Miniseries' for short/limited series, excluding " +
        "documentaries/reality/talk shows/etc. that would otherwise mix into a genre/rating search.",
    )
    .optional(),
  // Verified live (/discover/tv): air_date 2026-10-19..25 → 1744 (any show
  // with an episode airing that week); + with_networks=213 (Netflix) → 29;
  // a past week works too (2020-03-02..08 → 3386; 60694 Last Week Tonight is
  // in it, with an episode on 2020-03-08). gte alone → 2454. Inverted → 0.
  // TMDB's default timezone is America/New_York (single day 2026-10-20: 444
  // with no timezone and with America/New_York, 450 for UTC, 490 for
  // Europe/Berlin); the timezone param itself is not exposed (an unknown zone
  // silently falls back to the default).
  air_date_gte: dateStr(
    "Only shows with an episode airing on/after this date (YYYY-MM-DD) — e.g. 'what's airing " +
      "this week' with air_date_lte; unlike release_date_gte, which uses the show's first " +
      "air date. Dates are US Eastern time. Must be <= air_date_lte if both are given.",
  ),
  air_date_lte: dateStr(
    "Only shows with an episode airing on/before this date (YYYY-MM-DD), see air_date_gte.",
  ),
  with_status: z
    .enum(TV_STATUSES)
    .describe(
      "Restrict to this production status, e.g. 'Ended' to exclude shows still airing (a still-" +
        "airing show's later seasons could still be mediocre or unfinished).",
    )
    .optional(),
};

// clients/tmdb.ts's DiscoverParams is z.infer'd from this merged shape
// instead of a hand-duplicated interface, so adding a field to either variant
// above automatically extends it — DISCOVER_FIELD_MAP (clients/tmdb.ts)
// still forces a compile error if the new field has no TMDB query-key mapping.
// sort_by is spread from both variants with genuinely different enums (movie
// vs. tv vocabulary) — the plain object spread below would let discoverTvSchema's
// definition silently win, narrowing the merged type to TV-only values and
// breaking assignability from a real discover_movies call's args. Re-widen it
// explicitly to the union of both, matching what discoverQuery actually forwards.
//
// Non-strict `z.object` (not strictObject) on purpose: this schema exists only
// as the z.infer source for the DiscoverParams type — it never .parse()s
// untrusted input. The actual per-tool input validation is the strict
// discoverMovieInputSchema/discoverTvInputSchema (strictObject + superRefine).
export const discoverParamsSchema = z.object({
  ...discoverMovieSchema,
  ...discoverTvSchema,
  sort_by: z.union([z.enum(MOVIE_SORT_BY), z.enum(TV_SORT_BY)]).optional(),
});
export type DiscoverParams = z.infer<typeof discoverParamsSchema>;

// TMDB silently ignores certification/with_watch_providers/
// without_watch_providers/with_watch_monetization_types/with_release_type/region
// when their required pair field is missing, instead of erroring — which reads as "the filter was
// applied" when it wasn't. Catch that here instead of round-tripping to TMDB.
function checkDiscoverFilterPairs(
  val: {
    min_rating?: number;
    max_rating?: number;
    min_runtime?: number;
    max_runtime?: number;
    release_date_gte?: string;
    release_date_lte?: string;
    any_release_date_gte?: string;
    any_release_date_lte?: string;
    air_date_gte?: string;
    air_date_lte?: string;
    with_release_type?: readonly string[];
    region?: string;
    with_watch_providers?: string;
    without_watch_providers?: string;
    with_watch_monetization_types?: readonly string[];
    watch_region?: string;
    certification?: string;
    certification_country?: string;
  },
  ctx: z.RefinementCtx,
): void {
  if (
    val.min_rating !== undefined &&
    val.max_rating !== undefined &&
    val.min_rating > val.max_rating
  ) {
    ctx.addIssue({
      code: "custom",
      message: "min_rating must be <= max_rating.",
      path: ["min_rating"],
    });
  }
  if (
    val.min_runtime !== undefined &&
    val.max_runtime !== undefined &&
    val.min_runtime > val.max_runtime
  ) {
    ctx.addIssue({
      code: "custom",
      message: "min_runtime must be <= max_runtime.",
      path: ["min_runtime"],
    });
  }
  // Verified live: an inverted date range is not an error upstream — TMDB
  // answers 200 with total_results:0, which reads as "nothing matched".
  // Both are z.iso.date() (YYYY-MM-DD), so a string compare orders them.
  for (const [gte, lte] of [
    ["release_date_gte", "release_date_lte"],
    ["any_release_date_gte", "any_release_date_lte"],
    ["air_date_gte", "air_date_lte"],
  ] as const) {
    const lo = val[gte];
    const hi = val[lte];
    if (lo !== undefined && hi !== undefined && lo > hi) {
      ctx.addIssue({ code: "custom", message: `${gte} must be <= ${lte}.`, path: [gte] });
    }
  }
  // Verified live: with neither any_release_date bound, with_release_type and
  // region leave total_results unchanged (see their schema comments).
  const hasReleaseWindow =
    val.any_release_date_gte !== undefined || val.any_release_date_lte !== undefined;
  for (const field of ["with_release_type", "region"] as const) {
    if (val[field] !== undefined && !hasReleaseWindow) {
      ctx.addIssue({
        code: "custom",
        message: `${field} requires any_release_date_gte or any_release_date_lte to also be set.`,
        path: [field],
      });
    }
  }
  if (val.with_watch_providers !== undefined && val.watch_region === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "with_watch_providers requires watch_region to also be set.",
      path: ["with_watch_providers"],
    });
  }
  if (val.without_watch_providers !== undefined && val.watch_region === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "without_watch_providers requires watch_region to also be set.",
      path: ["without_watch_providers"],
    });
  }
  if (val.with_watch_monetization_types !== undefined && val.watch_region === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "with_watch_monetization_types requires watch_region to also be set.",
      path: ["with_watch_monetization_types"],
    });
  }
  if (val.certification !== undefined && val.certification_country === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "certification requires certification_country to also be set.",
      path: ["certification"],
    });
  }
  // The reverse direction: verified live, watch_region or certification_country
  // alone returns the fully unfiltered result set, so a caller would read an
  // unfiltered page as "filtered by region/country".
  if (
    val.watch_region !== undefined &&
    val.with_watch_providers === undefined &&
    val.without_watch_providers === undefined &&
    val.with_watch_monetization_types === undefined
  ) {
    ctx.addIssue({
      code: "custom",
      message:
        "watch_region only applies to with_watch_providers / without_watch_providers / " +
        "with_watch_monetization_types; " +
        "set it together with at least one of them, or omit it.",
      path: ["watch_region"],
    });
  }
  if (val.certification_country !== undefined && val.certification === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "certification_country only applies to certification; set both or neither.",
      path: ["certification_country"],
    });
  }
}

const discoverMovieInputSchema = z
  .strictObject(discoverMovieSchema)
  .superRefine(checkDiscoverFilterPairs);
const discoverTvInputSchema = z
  .strictObject(discoverTvSchema)
  .superRefine(checkDiscoverFilterPairs);

export function registerDiscoverTools(
  server: McpServer,
  { tmdb, requireTmdb, requireTmdbCached, region }: TmdbToolDeps,
): void {
  server.registerTool(
    "get_trending",
    {
      title: "Get trending titles",
      description:
        "Get what's trending on TMDB. media_type selects movies, TV, people, or all; time_window " +
        "is the trending period (today vs this week). Good for 'what's popular right now'. Each " +
        "result row carries its own media_type ('movie' | 'tv' | 'person') — check it to route to " +
        "the right get_* tool, especially when media_type is left at 'all'.",
      inputSchema: z.strictObject({
        media_type: z
          .enum(["all", "movie", "tv", "person"])
          .describe("Which kind of entity to rank. Defaults to 'all'.")
          .optional(),
        time_window: z
          .enum(["day", "week"])
          .describe("Trending period: 'day' or 'week'. Defaults to 'week'.")
          .optional(),
        page: page.optional(),
      }),
      outputSchema: pageSchema(multiItemSchema),
      annotations: READ_ONLY,
    },
    ({ media_type, time_window, page: pg }, ctx) =>
      requireTmdb(
        () =>
          tmdb.getTrending(
            media_type ?? "all",
            time_window ?? "week",
            pg,
            undefined,
            ctx.mcpReq.signal,
          ),
        ctx.mcpReq.signal,
      ),
  );

  server.registerTool(
    "get_movie_releases",
    // Verified live 2026-10-20: now_playing DE → 162 results, US → 539, no
    // region → 7320, ZZ → 0; `dates` identical across regions. Rows carry the
    // region's release date (e.g. upcoming DE included 131631, a 2014 film
    // with a DE theatrical re-release on 2026-10-22, release_date 2014-11-20).
    {
      title: "Get movies in or coming to cinemas",
      description:
        "List movies in cinemas now (list='now_playing') or opening soon (list='upcoming') in " +
        "one country — for 'what's playing in theaters' or 'what comes out next month'. Use " +
        "get_trending for overall popularity regardless of release, discover_movies for an " +
        "arbitrary date range. `region` filters to movies with a theatrical release in that " +
        "country inside the window (a different set per country, not just a re-sort; an " +
        "unknown code returns an empty page), and each row's release_date is that country's " +
        "release date, which can predate the window for a re-release (e.g. a 2014 film " +
        "re-released this month). The window itself comes from TMDB and is returned as " +
        "`dates` {minimum, maximum} (YYYY-MM-DD; same for every region — roughly the last six " +
        "weeks for now_playing, the next three weeks for upcoming). TMDB's own order: roughly " +
        "most popular first, not by date.",
      inputSchema: z.strictObject({
        list: z
          .enum(["now_playing", "upcoming"])
          .describe("'now_playing' = in cinemas now; 'upcoming' = opening soon."),
        region,
        language,
        page: page.optional(),
      }),
      outputSchema: movieReleasesSchema,
      annotations: READ_ONLY,
    },
    ({ list, ...p }, ctx) =>
      requireTmdb(() => tmdb.getMovieReleases(list, p, ctx.mcpReq.signal), ctx.mcpReq.signal),
  );

  server.registerTool(
    "get_movie_genres",
    {
      title: "List movie genres",
      description:
        "List TMDB movie genres with their numeric ids and names (reference data; rarely changes). " +
        "Feed the ids into discover_movies' with_genres/without_genres.",
      inputSchema: z.strictObject({}),
      outputSchema: genresSchema,
      annotations: READ_ONLY,
    },
    (_args, ctx) => {
      return requireTmdbCached(
        (onStale) => tmdb.getGenres("movie", undefined, onStale),
        ctx.mcpReq.signal,
      );
    },
  );

  server.registerTool(
    "get_tv_genres",
    {
      title: "List TV genres",
      description:
        "List TMDB TV genres with their numeric ids and names (reference data; rarely changes). " +
        "Feed the ids into discover_tv's with_genres/without_genres.",
      inputSchema: z.strictObject({}),
      outputSchema: genresSchema,
      annotations: READ_ONLY,
    },
    (_args, ctx) => {
      return requireTmdbCached(
        (onStale) => tmdb.getGenres("tv", undefined, onStale),
        ctx.mcpReq.signal,
      );
    },
  );

  server.registerTool(
    "discover_movies",
    {
      title: "Discover movies (filters)",
      description:
        "Find movies by structured filters instead of a title query: genres (include/exclude), " +
        "year or release-date range, TMDB vote-average range, vote count, runtime range, original language, " +
        "cast/crew/people, companies (include/exclude), origin country, keywords, watch providers " +
        "(include/exclude) and access model (subscription/rent/buy/free/ads), certification, " +
        "a release window in one country by release type (any_release_date_gte/lte + region + " +
        "with_release_type — e.g. 'movies in German cinemas this month'), an adult-content " +
        "toggle, and sort order. certification/with_watch_providers/without_watch_providers/" +
        "with_watch_monetization_types/with_release_type/region have validation and " +
        "silent-fallback rules — see their own field descriptions. Use for " +
        "'popular sci-fi from the 1990s with a TMDB vote average above 7 available on Netflix', or for a specific " +
        "person's work in one genre — 'which of this director's/actor's/composer's films are " +
        "animated' — via with_crew/with_cast/with_people + with_genres together; get_person_credits " +
        "has no genre filter, so this combination is the right tool for that question, not that one. " +
        "Resolve ids with get_movie_genres, search_people, search_keywords, search_companies, " +
        "search_watch_providers.",
      inputSchema: discoverMovieInputSchema,
      outputSchema: pageSchema(movieSummarySchema),
      annotations: READ_ONLY,
    },
    (args, ctx) =>
      requireTmdb(() => tmdb.discover("movie", args, ctx.mcpReq.signal), ctx.mcpReq.signal),
  );

  server.registerTool(
    "discover_tv",
    {
      title: "Discover TV shows (filters)",
      description:
        "Find TV shows by structured filters (genres, first-air year or date range, TMDB vote-average range, " +
        "vote count, runtime, language, origin country, companies (include/exclude), networks, " +
        "keywords, watch providers (include/exclude) and access model (subscription/rent/buy/" +
        "free/ads), episodes airing in a date range (air_date_gte/lte), type, " +
        "status, certification, an adult-content toggle, sort) — but NOT cast/crew/person: this " +
        "tool doesn't accept those " +
        "params for TV at all (calling with them is a validation error, not a silent no-op) " +
        "because TMDB's own /discover/tv would silently ignore them anyway, unlike /discover/movie; " +
        "to find TV shows featuring someone, call get_person_credits instead and filter its results " +
        "to media_type 'tv'. certification/with_watch_providers/without_watch_providers/" +
        "with_watch_monetization_types have validation and silent-fallback " +
        "rules — see their own field descriptions. The TV counterpart of discover_movies; " +
        "use with_networks for 'HBO shows', with_type='Miniseries' for short/limited series (e.g. " +
        "'best miniseries to binge in a weekend'), with_status='Ended' to exclude shows still " +
        "airing, certification='TV-Y7' + certification_country='US' for 'shows appropriate for a " +
        "young kid'. Resolve ids with get_tv_genres, search_companies, search_keywords, " +
        "search_watch_providers.",
      inputSchema: discoverTvInputSchema,
      outputSchema: pageSchema(tvSummarySchema),
      annotations: READ_ONLY,
    },
    (args, ctx) =>
      requireTmdb(() => tmdb.discover("tv", args, ctx.mcpReq.signal), ctx.mcpReq.signal),
  );
}
