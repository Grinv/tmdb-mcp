import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";

describe("loadConfig", () => {
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

  // An invalid env value must fail loudly with a message naming the field and
  // the constraint it violated — not a raw ZodError stack, and not a silent
  // fallback to a default that hides the user's typo.
  test("an invalid enum value (LOG_LEVEL) throws a readable error naming the field", () => {
    assert.throws(() => loadConfig({ LOG_LEVEL: "verbose" }), /LOG_LEVEL/);
  });

  test("a malformed TMDB_REGION (not two uppercase letters) throws a readable error", () => {
    assert.throws(() => loadConfig({ TMDB_REGION: "usa" }), /TMDB_REGION/);
  });

  test("a non-numeric tunable (HTTP_RETRIES) throws a readable error, not a silent NaN", () => {
    assert.throws(() => loadConfig({ HTTP_RETRIES: "not-a-number" }), /HTTP_RETRIES/);
  });

  test("an out-of-range tunable (negative HTTP_RETRIES) throws a readable error", () => {
    assert.throws(() => loadConfig({ HTTP_RETRIES: "-1" }), /HTTP_RETRIES/);
  });

  test("an invalid TMDB_BASE_URL (not a URL) throws a readable error", () => {
    assert.throws(() => loadConfig({ TMDB_BASE_URL: "not-a-url" }), /TMDB_BASE_URL/);
  });
});
