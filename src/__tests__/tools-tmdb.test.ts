import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { maybeEnrich } from "../tools/tmdb/details.ts";
import type { OmdbClient } from "../clients/omdb.ts";
import { ApiError } from "../lib/errors.ts";
import { recordingLogger, silentLogger } from "./helpers.ts";

// get_movie/get_tv's degrade-gracefully policy, tested directly against the
// policy function instead of round-tripping the full MCP server twice (once
// per media type) for every branch.

describe("maybeEnrich", () => {
  test("skips OMDb entirely when ratings were not requested", async () => {
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

  test("reports not-configured without calling OMDb", async () => {
    const omdb = { configured: false } as unknown as OmdbClient;
    const res = await maybeEnrich({ title: "x" }, "tt123", true, omdb);
    assert.deepEqual(res.ratings, { found: false, reason: "OMDB_API_KEY not configured" });
  });

  test("reports missing imdb_id without calling OMDb", async () => {
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

  test("folds in OMDb's ratings on success", async () => {
    const omdb = {
      configured: true,
      ratingsByImdbId: async (id: string) => ({ found: true, imdb_id: id, imdb_rating: "8.7" }),
    } as unknown as OmdbClient;
    const res = await maybeEnrich({ title: "x" }, "tt0133093", true, omdb);
    assert.deepEqual(res.ratings, { found: true, imdb_id: "tt0133093", imdb_rating: "8.7" });
  });

  // A non-ApiError is a bug: it used to vanish into a bare "OMDb lookup
  // failed" with nothing logged; now it's logged and named as internal.
  test("degrades to found:false when OMDb throws, and logs an internal error", async () => {
    const { logger, errors } = recordingLogger();
    const omdb = {
      configured: true,
      logger,
      ratingsByImdbId: async () => {
        throw new Error("boom");
      },
    } as unknown as OmdbClient;
    const res = await maybeEnrich({ title: "x" }, "tt0133093", true, omdb);
    assert.equal(res.title, "x");
    assert.equal(res.ratings?.found, false);
    assert.match((res.ratings as { reason: string }).reason, /^OMDb lookup failed: Internal error/);
    assert.equal((errors[0]![1] as Error).message, "boom");
  });

  test("names the cause when OMDb fails with an ApiError (e.g. a rejected key)", async () => {
    // Live: an invalid OMDB_API_KEY gets HTTP 401 {"Response":"False","Error":"Invalid API key!"},
    // which the HTTP client surfaces as ApiError code "unauthorized".
    const omdb = {
      configured: true,
      ratingsByImdbId: async () => {
        throw new ApiError({ code: "unauthorized", status: 401, message: "HTTP 401" });
      },
      logger: silentLogger(),
    } as unknown as OmdbClient;
    const res = await maybeEnrich({ title: "x" }, "tt0133093", true, omdb);
    assert.equal(res.ratings?.found, false);
    assert.match(
      (res.ratings as { reason: string }).reason,
      /^OMDb lookup failed: The upstream service rejected the credentials \(401\)/,
    );
  });
});
