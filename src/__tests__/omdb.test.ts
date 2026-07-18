import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  connectServer,
  installFetch,
  mockFetch,
  jsonResponse,
  toolText,
  DEFAULT_ENV as ENV,
} from "./helpers.js";

const OMDB_OK = {
  Response: "True",
  Title: "The Matrix",
  Year: "1999",
  Rated: "R",
  Runtime: "136 min",
  imdbRating: "8.7",
  imdbVotes: "2,000,000",
  imdbID: "tt0133093",
  Metascore: "73",
  Ratings: [
    { Source: "Internet Movie Database", Value: "8.7/10" },
    { Source: "Rotten Tomatoes", Value: "83%" },
    { Source: "Metacritic", Value: "73/100" },
  ],
};

describe("get_ratings", () => {
  test("looks up ratings by imdb_id", async (t) => {
    installFetch(
      t,
      mockFetch(() => jsonResponse(OMDB_OK)),
    );
    const { client, close } = await connectServer(ENV);
    t.after(close);
    const res = await client.callTool({
      name: "get_ratings",
      arguments: { imdb_id: "tt0133093" },
    });
    const s = res.structuredContent as { found: boolean; metascore: string };
    assert.equal(s.found, true);
    assert.equal(s.metascore, "73");
  });

  test("looks up ratings by title and year, not imdb_id", async (t) => {
    const mock = mockFetch(() => jsonResponse(OMDB_OK));
    installFetch(t, mock);
    const { client, close } = await connectServer(ENV);
    t.after(close);
    const res = await client.callTool({
      name: "get_ratings",
      arguments: { title: "The Matrix", year: 1999 },
    });
    assert.notEqual(res.isError, true);
    const s = res.structuredContent as { found: boolean };
    assert.equal(s.found, true);
    const url = mock.calls[0]!.url;
    assert.match(url, /[?&]t=The(\+|%20)Matrix/);
    assert.match(url, /[?&]y=1999/);
    assert.ok(!url.includes("&i=") && !url.includes("?i="), "should not send an imdb_id param");
  });

  test("returns a soft not-found result on an OMDb miss, without throwing", async (t) => {
    installFetch(
      t,
      mockFetch(() => jsonResponse({ Response: "False", Error: "Movie not found!" })),
    );
    const { client, close } = await connectServer(ENV);
    t.after(close);
    const res = await client.callTool({ name: "get_ratings", arguments: { imdb_id: "tt0000000" } });
    assert.notEqual(res.isError, true);
    const s = res.structuredContent as { found: boolean; reason: string };
    assert.equal(s.found, false);
    assert.equal(s.reason, "Movie not found!");
  });

  describe("error priority", () => {
    // OMDb misconfiguration must surface before argument-validation errors —
    // otherwise an agent chases "provide an id" when the real blocker is a
    // missing OMDB_API_KEY, costing an extra round trip to discover it.
    test("reports OMDb not configured even when imdb_id/title are also missing", async (t) => {
      installFetch(
        t,
        mockFetch(() => jsonResponse({})),
      );
      const { client, close } = await connectServer({ TMDB_API_TOKEN: "t" }); // no OMDB_API_KEY
      t.after(close);
      const res = await client.callTool({ name: "get_ratings", arguments: {} });
      assert.equal(res.isError, true);
      const text = toolText(res);
      assert.match(text, /OMDB_API_KEY/);
    });

    test("reports the argument error when OMDb IS configured but neither imdb_id nor title is given", async (t) => {
      installFetch(
        t,
        mockFetch(() => jsonResponse({})),
      );
      const { client, close } = await connectServer(ENV);
      t.after(close);
      const res = await client.callTool({ name: "get_ratings", arguments: {} });
      assert.equal(res.isError, true);
      const text = toolText(res);
      assert.match(text, /Provide either imdb_id or title/);
    });
  });
});
