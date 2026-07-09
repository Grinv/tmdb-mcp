// Pre-deploy health check for the upstream APIs this server depends on. Each
// check asserts a 200 plus a minimal response shape, so a release can be gated
// against upstream drift. Wired into release.yml before packing.
//
// Credentials come from the environment:
//   TMDB_API_TOKEN  — TMDB v4 Read Access Token (required for TMDB checks)
//   OMDB_API_KEY    — OMDb key (optional; that check is skipped when unset)
//
// Run: `npm run check:api`.

const TMDB_BASE = process.env.TMDB_BASE_URL ?? "https://api.themoviedb.org/3";
const OMDB_BASE = process.env.OMDB_BASE_URL ?? "https://www.omdbapi.com";
const TMDB_TOKEN = process.env.TMDB_API_TOKEN;
const OMDB_KEY = process.env.OMDB_API_KEY;
const SPACING_MS = 300;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Assert a 200 + minimal shape from a TMDB endpoint, with auth + the skip guard.
const tmdbCheck = (name, path, assert) => ({
  name,
  skip: TMDB_TOKEN ? undefined : "TMDB_API_TOKEN not set",
  run: async () => {
    const res = await fetch(`${TMDB_BASE}${path}`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${TMDB_TOKEN}` },
    });
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
    assert(await res.json());
  },
});

const hasResults = (b) => {
  if (!Array.isArray(b.results)) throw new Error("missing `results` array");
};

/** @type {{name:string, skip?:string, run:() => Promise<void>}[]} */
const checks = [
  tmdbCheck("tmdb search/movie", "/search/movie?query=matrix", hasResults),
  // 603 = The Matrix; its detail must carry imdb_id (the OMDb enrichment depends on it).
  tmdbCheck("tmdb movie/{id} has imdb_id", "/movie/603", (b) => {
    if (typeof b.imdb_id !== "string") throw new Error("missing `imdb_id`");
  }),
  tmdbCheck(
    "tmdb discover/movie",
    "/discover/movie?sort_by=popularity.desc&vote_count.gte=100",
    hasResults,
  ),
  tmdbCheck("tmdb movie/{id}/similar", "/movie/603/similar", hasResults),
  tmdbCheck("tmdb movie/{id}/reviews", "/movie/155/reviews", hasResults),
  // 263 = The Dark Knight Collection; get_collection depends on `parts`.
  tmdbCheck("tmdb collection/{id} has parts", "/collection/263", (b) => {
    if (!Array.isArray(b.parts)) throw new Error("missing `parts` array");
  }),
  {
    name: "omdb ratings by imdb_id",
    skip: OMDB_KEY ? undefined : "OMDB_API_KEY not set",
    run: async () => {
      const res = await fetch(`${OMDB_BASE}/?apikey=${OMDB_KEY}&i=tt0133093`, {
        headers: { Accept: "application/json" },
      });
      if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
      const body = await res.json();
      if (body.Response !== "True") throw new Error(`OMDb error: ${body.Error ?? "unknown"}`);
      if (typeof body.imdbRating !== "string") throw new Error("missing `imdbRating`");
    },
  },
];

const failures = [];
let ran = 0;
for (const check of checks) {
  if (check.skip) {
    console.log(`  skip ${check.name} (${check.skip})`);
    continue;
  }
  ran += 1;
  try {
    await check.run();
    console.log(`  ok   ${check.name}`);
  } catch (err) {
    failures.push(check.name);
    console.error(`  FAIL ${check.name}: ${err instanceof Error ? err.message : String(err)}`);
  }
  await delay(SPACING_MS);
}

if (failures.length) {
  console.error(`\n${failures.length}/${ran} API checks failed.`);
  process.exit(1);
}
console.log(`\nAll ${ran} API check(s) passed${ran < checks.length ? " (some skipped)" : ""}.`);
