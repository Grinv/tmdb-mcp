import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";

test("empty strings are treated as unset (so .mcpb blanks don't override defaults)", () => {
  const c = loadConfig({ TMDB_API_TOKEN: "", OMDB_API_KEY: "", TMDB_LANGUAGE: "" });
  assert.equal(c.tmdbApiToken, undefined);
  assert.equal(c.omdbApiKey, undefined);
  assert.equal(c.tmdbLanguage, "en-US"); // default applies
});

test("unsubstituted .mcpb placeholders are treated as unset", () => {
  // An unfilled optional field arrives as the literal "${user_config.X}".
  const c = loadConfig({
    TMDB_API_TOKEN: "${user_config.tmdb_api_token}",
    OMDB_API_KEY: "${user_config.omdb_api_key}",
  });
  // Must NOT be taken as a real token/key (else the client would send garbage).
  assert.equal(c.tmdbApiToken, undefined);
  assert.equal(c.omdbApiKey, undefined);
});

test("real values pass through untouched", () => {
  const c = loadConfig({
    TMDB_API_TOKEN: "eyJhbGciOiJ0oken",
    OMDB_API_KEY: "abc123",
    TMDB_LANGUAGE: "ru-RU",
    TMDB_REGION: "RU",
  });
  assert.equal(c.tmdbApiToken, "eyJhbGciOiJ0oken");
  assert.equal(c.omdbApiKey, "abc123");
  assert.equal(c.tmdbLanguage, "ru-RU");
  assert.equal(c.tmdbRegion, "RU");
});
