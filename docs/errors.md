# Tool errors

A failed tool call follows the MCP spec: an `isError: true` result whose text
content explains the failure to the model, so it can correct itself. The same
failure is also attached for the client application as an
[RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem details object in
the result's `_meta["io.github.Grinv.tmdb-mcp/problem"]` — never in `structuredContent`, which
MCP reserves for data matching the tool's `outputSchema`.

```json
{
  "type": "https://github.com/Grinv/tmdb-mcp/blob/main/docs/errors.md#unauthorized",
  "title": "The upstream service rejected the credentials",
  "detail": "The upstream service rejected the credentials (401). They may be missing, invalid or expired — check the configured API key / token. The upstream said: \"Invalid API key!\"",
  "retryable": false,
  "upstream_status": 401
}
```

- `type` — stable URI of the problem type: one of the sections below.
- `title` — fixed summary of the type.
- `detail` — this occurrence, as the model reads it (the result's text).
- `retryable` — whether the failure is transient, so trying the same call
  again later can help. The server retries a transient upstream failure
  itself first, up to `HTTP_RETRIES` times (none when it is 0).
- `upstream_status` — the TMDB/OMDb HTTP status, when there was one. RFC
  9457's own `status` member (the status of _this_ HTTP response) is not used:
  MCP results have none.

The text never includes an error's raw upstream body or internal message.

Scope: every failure raised while a tool runs carries a problem. Arguments
that fail a tool's input schema (or exceed its element limit) are rejected by
the MCP SDK before the tool runs: that `isError` result carries the SDK's own
text — which lists what is wrong, so the model can fix the call — and no
problem object. The SDK's own output-schema check is a backstop only: each
shaper checks what it builds against its schema while the tool runs (a
mismatch surfaces as [internal](#internal)), and the test suite checks every
tool's whole result against its output schema.

## unauthorized

TMDB or OMDb rejected the configured token/key: missing, invalid or expired.
Fix `TMDB_API_TOKEN` / `OMDB_API_KEY`.

## forbidden

The credentials are valid but lack access to this resource.

## not_found

No such movie, show, person, season, episode or collection — check the id.

## rate_limited

The upstream is throttling requests, or OMDb's daily quota is used up
(`retryable` is then false: it resets on OMDb's schedule, not in seconds).

## server_error

The upstream failed (HTTP 5xx). Retry later.

## network

The upstream could not be reached. Check connectivity.

## timeout

The upstream did not answer within `HTTP_TIMEOUT_MS` (headers and body), or
a proxy in front of it gave up (HTTP 408).

## cancelled

The client cancelled the call.

## bad_request

The upstream rejected the request as invalid (HTTP 400/405/422).

## bad_response

The upstream answered with a success status but an unreadable body: invalid
JSON, no body at all, or JSON that isn't an object or array. That is a
complete reply such as a proxy's or captive portal's page, so `retryable` is
false. The API itself wasn't reached, though, so like a 5xx it counts as an
outage: a cached copy may be served instead, flagged stale in `_meta`. (A
reply cut off mid-body is a [network](#network) error.)

## unknown

Any other upstream status or refusal; `detail` carries the upstream's reason.

## internal

A bug in tmdb-mcp. The full error (stack and cause chain) is in the server log
on stderr; please report it.

It is a tool result with `isError`, not a JSON-RPC error. The spec lists
"server errors" among protocol errors, but also says errors that originate
from the tool SHOULD be reported inside the result so the model sees the call
failed; a bug while running a tool is the latter. The reference TypeScript SDK
resolves it the same way: a tool handler produces only tool errors (every
exception becomes `isError`).

## not_configured

The tool's upstream has no credentials configured; `detail` names the
environment variable to set.

## invalid_arguments

The arguments passed this tool's schema but not its own cross-field check
(e.g. `get_ratings` with neither `imdb_id` nor `title`).
