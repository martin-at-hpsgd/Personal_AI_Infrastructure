---
convention: lifeos-freshness-v1
spec_version: 2026-07-28
spec_supersedes: 2025-11-25
last_updated: 2026-07-30
source: https://modelcontextprotocol.io/specification/2026-07-28/changelog
---

# MCP Server Build Contract — spec `2026-07-28`

**Contents:** Why this matters for us · The stateless core · `server/discover` — servers MUST implement it · Results · Caching — `CacheableResult` · Transport — Streamable HTTP · Removed methods · Error codes · Extensions · Do not adopt — deprecated (12-month minimum window) · Authorization · Schemas and observability · Gotchas

> **This is the structure every MCP server we build uses, unless there's a stated reason not to.**
> Normative requirements below are transcribed from the official spec changelog and spec index
> (fetched 2026-07-30). Sub-pages (`basic/transports/streamable-http`, `basic/authorization`,
> `basic/patterns/mrtr`) were NOT read in full — read them before implementing the wire format.
> Authoritative schema: `schema/2026-07-28/schema.ts` in the `modelcontextprotocol/specification` repo.

## Why this matters for us

The spec went **stateless**. An MCP server is now a plain request/response HTTP service, which means
it is a **plain Worker** — no Durable Object, no session affinity, no connection state to hold. That
is the entire reason this contract lives in the Cloudflare skill: our MCP servers and our Workers are
now the same deployment shape.

## The stateless core

- **No handshake.** `initialize` and `notifications/initialized` are GONE. Every request is
  self-contained and carries its own context.
- **No protocol-level sessions.** The `Mcp-Session-Id` header is REMOVED. `tools/list`,
  `resources/list`, and `prompts/list` no longer vary per connection.
- **Cross-call state uses server-minted handles passed as ordinary tool arguments.** Never a session.
- Per-request `_meta` keys:

  | Key | Direction | Requirement |
  |-----|-----------|-------------|
  | `io.modelcontextprotocol/protocolVersion` | client → server | on every request |
  | `io.modelcontextprotocol/clientCapabilities` | client → server | on every request |
  | `io.modelcontextprotocol/clientInfo` | client → server | client SHOULD send |
  | `io.modelcontextprotocol/serverInfo` | server → client | server SHOULD send in each result's `_meta` |
  | `io.modelcontextprotocol/logLevel` | client → server | per-request log level |

- Version mismatch returns `UnsupportedProtocolVersionError`.

## `server/discover` — servers MUST implement it

Advertises supported protocol versions, capabilities, and identity. Clients MAY call it before any
other request for up-front version selection, or use it as a backward-compatibility probe on STDIO.
This is the one RPC a server cannot skip.

## Results

- **Every result carries a required `resultType`**: `"complete"` for ordinary results,
  `"input_required"` for interim MRTR results. Clients MUST treat a missing `resultType` from an
  earlier-protocol server as `"complete"`.
- **Multi Round-Trip Requests (MRTR) replace all server-initiated requests.** There is no more
  `roots/list`, `sampling/createMessage`, or `elicitation/create` from the server. Instead the server
  returns an `InputRequiredResult` whose `inputRequests` field carries what it needs; the client
  retries the *original* request supplying `inputResponses`. A server correlating an interaction
  across retries encodes its own identifier in `requestState`.

## Caching — `CacheableResult`

`ttlMs` and `cacheScope` are REQUIRED on results returned by `tools/list`, `prompts/list`,
`resources/list`, `resources/read`, and `resources/templates/list`.

- `ttlMs` — freshness hint in milliseconds; lets clients cache and stop polling.
- `cacheScope` — `"public"` or `"private"`; controls whether shared intermediaries may cache.
- `tools/list` SHOULD return tools in **deterministic order** — it improves client-side caching and
  LLM prompt-cache hit rates. Non-deterministic ordering silently costs money on every call.

## Transport — Streamable HTTP

- **Required headers on POST:** `Mcp-Method`, `Mcp-Name`. Custom headers from tool parameters go via
  `x-mcp-header`.
- **The HTTP GET endpoint is gone**, as are `resources/subscribe` / `resources/unsubscribe`. They are
  replaced by `subscriptions/listen` — a single long-lived POST-response stream for opted-in
  server-to-client change notifications. Clients opt into specific types (`toolsListChanged`,
  `promptsListChanged`, `resourcesListChanged`, `resourceSubscriptions`); the server acknowledges and
  tags notifications with `io.modelcontextprotocol/subscriptionId`.
- **Request-scoped notifications do NOT use that stream.** `notifications/progress` and
  `notifications/message` flow on the response stream of the request they relate to.
- **No stream resumability.** `Last-Event-ID` and SSE event IDs are removed. A broken response stream
  loses the in-flight request; the client MUST re-issue it as a new request with a new request ID.
  Design server work to be safely re-issuable.

## Removed methods

`ping`, `logging/setLevel`, `notifications/roots/list_changed`,
`notifications/elicitation/complete`, and the `elicitationId` field of URL-mode elicitation.

Servers MUST NOT emit `notifications/message` for requests that did not include
`io.modelcontextprotocol/logLevel`.

## Error codes

| Range | Ownership |
|-------|-----------|
| `-32000` … `-32019` | implementation-defined (existing SDK usage grandfathered) |
| `-32020` … `-32099` | reserved for the MCP specification |

Renumbered this version: `HeaderMismatch` `-32001` → **`-32020`**,
`MissingRequiredClientCapability` `-32003` → **`-32021`**,
`UnsupportedProtocolVersion` `-32004` → **`-32022`**.
Resource-not-found moved `-32002` → **`-32602`** (Invalid Params) to match JSON-RPC.

## Extensions

Anything beyond the core protocol is an opt-in extension, declared via the `extensions` field on
`ClientCapabilities` / `ServerCapabilities` and requiring explicit support from both sides.

- **`io.modelcontextprotocol/tasks`** — async long-running work. Poll with `tasks/get`; client→server
  input via `tasks/update`. The blocking `tasks/result` and `tasks/list` are gone. Servers MAY return
  task handles unsolicited, with no per-request opt-in.
- **MCP Apps** — interactive UI (charts, forms, players) rendered inline in the conversation. The one
  capability a CLI structurally cannot provide.
- **Skills over MCP** — structured agent-workflow instructions discovered and consumed through MCP.

## Do not adopt — deprecated (12-month minimum window)

New implementations should not add support for any of these:

- **Roots, Sampling, Logging.** Migrations: pass directories/files as tool parameters, resource URIs,
  or server config instead of Roots; integrate directly with LLM provider APIs instead of Sampling;
  log to `stderr` (stdio) or use OpenTelemetry instead of Logging.
- **HTTP+SSE transport** — use Streamable HTTP.
- **`includeContext` values `"thisServer"` / `"allServers"`** — omit the field or use `"none"`.
- **OAuth 2.0 Dynamic Client Registration (RFC 7591)** — use Client ID Metadata Documents. DCR stays
  only for backwards compatibility with authorization servers that lack CIMD support.

## Authorization

- Authorization servers SHOULD include the `iss` parameter in authorization responses (RFC 9207);
  clients MUST validate a present `iss` against the recorded issuer before redeeming the code.
- Clients MUST specify an appropriate `application_type` during Dynamic Client Registration to avoid
  OpenID Connect redirect-URI conflicts.
- **Credentials are bound to the authorization server that issued them.** Clients MUST key persisted
  credentials by issuer identifier, MUST NOT reuse them with a different authorization server, and
  MUST re-register when the authorization server changes.

## Schemas and observability

- `inputSchema` / `outputSchema` accept any JSON Schema 2020-12 keywords; `structuredContent` accepts
  any JSON value. `$ref` resolution requirements and composition-keyword resource bounds apply.
- OpenTelemetry trace context propagates through `_meta` keys `traceparent`, `tracestate`, `baggage`.

## Gotchas

- **A JSON HTTP API with `/tools` and `/call` endpoints is not an MCP server.** That shape was
  never spec-conformant at any version — it is a homegrown API that no MCP client can talk to. MCP is
  JSON-RPC 2.0 with defined methods (`server/discover`, `tools/list`, `tools/call`); if a "MCP server" has hand-rolled
  route names, it is not one.
- **Statelessness is a design constraint, not just a transport detail.** Any server needing
  continuity must mint an explicit handle and accept it back as a tool argument. Reaching for a
  Durable Object to hold session state is the old shape.
- **Deterministic `tools/list` ordering is a cost control**, not cosmetics — random ordering breaks
  the client's prompt cache on every call.
- **A dropped stream is not resumable.** Server-side work triggered by a request must tolerate the
  client re-issuing that request with a fresh ID.
