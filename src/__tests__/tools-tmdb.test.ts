import { test } from "node:test";
import assert from "node:assert/strict";
import { maybeEnrich } from "../tools/tmdb.js";
import type { OmdbClient } from "../clients/omdb.js";

// get_movie/get_tv's degrade-gracefully policy, tested directly against the
// policy function instead of round-tripping the full MCP server twice (once
// per media type) for every branch.

test("maybeEnrich: skips OMDb entirely when ratings were not requested", async () => {
  let called = false;
  const omdb = {
    configured: true,
    ratingsByImdbId: async () => {
      called = true;
      return {};
    },
  } as unknown as OmdbClient;
  const res = await maybeEnrich({ title: "x" }, "tt123", false, omdb);
  assert.deepEqual(res, { title: "x" });
  assert.equal(called, false);
});

test("maybeEnrich: reports not-configured without calling OMDb", async () => {
  const omdb = { configured: false } as unknown as OmdbClient;
  const res = await maybeEnrich({ title: "x" }, "tt123", true, omdb);
  assert.deepEqual(res.ratings, { found: false, reason: "OMDB_API_KEY not configured" });
});

test("maybeEnrich: reports missing imdb_id without calling OMDb", async () => {
  let called = false;
  const omdb = {
    configured: true,
    ratingsByImdbId: async () => {
      called = true;
      return {};
    },
  } as unknown as OmdbClient;
  const res = await maybeEnrich({ title: "x" }, null, true, omdb);
  assert.deepEqual(res.ratings, { found: false, reason: "No imdb_id available from TMDB" });
  assert.equal(called, false);
});

test("maybeEnrich: folds in OMDb's ratings on success", async () => {
  const omdb = {
    configured: true,
    ratingsByImdbId: async (id: string) => ({ found: true, imdb_id: id, imdb_rating: "8.7" }),
  } as unknown as OmdbClient;
  const res = await maybeEnrich({ title: "x" }, "tt0133093", true, omdb);
  assert.deepEqual(res.ratings, { found: true, imdb_id: "tt0133093", imdb_rating: "8.7" });
});

test("maybeEnrich: degrades to found:false when OMDb throws, without sinking the TMDB result", async () => {
  const omdb = {
    configured: true,
    ratingsByImdbId: async () => {
      throw new Error("boom");
    },
  } as unknown as OmdbClient;
  const res = await maybeEnrich({ title: "x" }, "tt0133093", true, omdb);
  assert.equal(res.title, "x");
  assert.deepEqual(res.ratings, { found: false, reason: "OMDb lookup failed" });
});
