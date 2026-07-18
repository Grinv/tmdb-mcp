import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { OmdbClient } from "../clients/omdb.js";
import { loadConfig } from "../config.js";
import { silentLogger, installFetch, mockFetch, jsonResponse } from "./helpers.js";

// Direct tests against OmdbClient's own interface, no MCP transport.

function client(): OmdbClient {
  return new OmdbClient(
    loadConfig({ OMDB_API_KEY: "k", OMDB_MIN_INTERVAL_MS: "0" }),
    silentLogger(),
  );
}

const OMDB_OK = { Response: "True", Title: "The Matrix", imdbID: "tt0133093" };

test("ratingsByImdbId sends the id as OMDb's `i` query param", async (t) => {
  const mock = mockFetch(() => jsonResponse(OMDB_OK));
  installFetch(t, mock);
  await client().ratingsByImdbId("tt0133093");
  assert.match(mock.calls[0]!.url, /[?&]i=tt0133093/);
});

test("ratingsByTitle sends `t` and, when given, `y`", async (t) => {
  const mock = mockFetch(() => jsonResponse(OMDB_OK));
  installFetch(t, mock);
  await client().ratingsByTitle("The Matrix", 1999);
  assert.match(mock.calls[0]!.url, /[?&]t=The\+Matrix/);
  assert.match(mock.calls[0]!.url, /[?&]y=1999/);
});

test("ratingsByTitle omits `y` entirely when no year is given", async (t) => {
  const mock = mockFetch(() => jsonResponse(OMDB_OK));
  installFetch(t, mock);
  await client().ratingsByTitle("The Matrix");
  assert.ok(!/[?&]y=/.test(mock.calls[0]!.url));
});

describe("OmdbClient: cache is wired through the real client, not just TtlCache in isolation", () => {
  test("ratingsByImdbId dedupes repeat lookups of the same id", async (t) => {
    const mock = mockFetch(() => jsonResponse(OMDB_OK));
    installFetch(t, mock);
    const c = client();
    await c.ratingsByImdbId("tt0133093");
    await c.ratingsByImdbId("tt0133093");
    assert.equal(mock.calls.length, 1);
  });

  test("ratingsByTitle does not conflate different years under the same cache slot", async (t) => {
    const mock = mockFetch(() => jsonResponse(OMDB_OK));
    installFetch(t, mock);
    const c = client();
    await c.ratingsByTitle("Dune", 1984);
    await c.ratingsByTitle("Dune", 2021);
    assert.equal(mock.calls.length, 2);
  });
});
