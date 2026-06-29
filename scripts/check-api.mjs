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

/** @type {{name:string, skip?:string, run:() => Promise<void>}[]} */
const checks = [
  {
    name: "tmdb search/movie",
    skip: TMDB_TOKEN ? undefined : "TMDB_API_TOKEN not set",
    run: async () => {
      const res = await fetch(`${TMDB_BASE}/search/movie?query=matrix`, {
        headers: { Accept: "application/json", Authorization: `Bearer ${TMDB_TOKEN}` },
      });
      if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
      const body = await res.json();
      if (!Array.isArray(body.results)) throw new Error("missing `results` array");
    },
  },
  {
    name: "tmdb movie/{id} has imdb_id",
    skip: TMDB_TOKEN ? undefined : "TMDB_API_TOKEN not set",
    run: async () => {
      // 603 = The Matrix (1999); its detail response must carry imdb_id, which
      // the OMDb enrichment path depends on.
      const res = await fetch(`${TMDB_BASE}/movie/603`, {
        headers: { Accept: "application/json", Authorization: `Bearer ${TMDB_TOKEN}` },
      });
      if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
      const body = await res.json();
      if (typeof body.imdb_id !== "string") throw new Error("missing `imdb_id`");
    },
  },
  {
    name: "tmdb discover/movie",
    skip: TMDB_TOKEN ? undefined : "TMDB_API_TOKEN not set",
    run: async () => {
      const res = await fetch(
        `${TMDB_BASE}/discover/movie?sort_by=popularity.desc&vote_count.gte=100`,
        { headers: { Accept: "application/json", Authorization: `Bearer ${TMDB_TOKEN}` } },
      );
      if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
      const body = await res.json();
      if (!Array.isArray(body.results)) throw new Error("missing `results` array");
    },
  },
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
