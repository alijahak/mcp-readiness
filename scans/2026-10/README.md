# How ready are registry MCP servers for the Claude and ChatGPT directories? (October 2026)

I ran `mcp-readiness` against a random sample of 200 remote servers from the official [MCP Registry](https://registry.modelcontextprotocol.io). This page gives the method, the numbers, and where the checker's own heuristics went wrong.

## Short version

- **Only 31% of the public servers had no directory-blocking finding on any profile** (37 of 119). By directory: 47% for Claude, 37% for ChatGPT.
- **The most common blocker is missing hints.** 60% of servers have at least one tool without all three hints ChatGPT requires (`readOnlyHint`, `destructiveHint`, `openWorldHint`). Across all 1,272 tools, only 42% carry all three.
- **Half the servers make Claude ask about reads.** 59 of 119 have read tools that aren't marked read-only (241 tools), so Claude asks the user to confirm every call.
- **OAuth discovery is mostly right.** 72% of the protected servers pass every Claude auth check. The usual failures are a `resource` that doesn't exactly match the server URL (8), and a 401 that doesn't point to the resource metadata (7).
- **No tool poisoning.** No hidden text (zero-width or bidi characters, Unicode tag characters, HTML comments) in any of the 1,272 tool definitions.
- **10% of registry endpoints didn't answer as MCP servers:** 404/405, 5xx, or no response.

## Method

1. **Registry snapshot.** Fetched `GET /v0/servers?version=latest` on 2026-10-03 (06:26 UTC): **38,660** servers, 24,054 with remote endpoints.
2. **Eligible endpoints.** A remote counted if it is a `streamable-http` URL on HTTPS, has no URL template variables, and declares no required header (an API key needed just to connect). That left **20,825** distinct URLs.
3. **Sample.** A seeded shuffle (`mulberry32(20261002)`), keeping **one endpoint per host** so no operator is probed twice, cut at **200**. The list is in [`sample.csv`](sample.csv).
4. **Probe.** The same requests any MCP client makes before sign-in:
   - one unauthenticated `initialize`;
   - on a 401, the protected resource metadata (RFC 9728), then the authorization server metadata (RFC 8414 / OpenID discovery);
   - on a 200, `tools/list`.
   No credentials were sent and **no tool was called**. Concurrency 8, 10 s timeout per request. The User-Agent identifies this repository.
5. **Rules.** The ones in the [README](../../README.md#rules), applied per profile (`claude`, `chatgpt`, `core`).

Scripts: [`scan.mjs`](scan.mjs) (snapshot, probe, re-list) and [`analyze.mjs`](analyze.mjs). Aggregates: [`aggregates.json`](aggregates.json). Per-server findings aren't published: most of these servers belong to individuals and small companies, and a public list of their defects helps nobody. To check your own server, run the tool on it.

## Results

### How the 200 endpoints answered an unauthenticated `initialize`

| Response | Servers |
|---|---:|
| 200: public, tools listed | 120 |
| 401: protected | 59 |
| 403 | 1 |
| 404 / 405 | 7 |
| 5xx | 6 |
| No response (DNS, TLS, timeout) | 7 |

### OAuth discovery on the 60 protected servers

| Check | Result |
|---|---:|
| 401 points to resource metadata (`WWW-Authenticate: ... resource_metadata=`) | 52 (87%) |
| Protected resource metadata found (header or well-known fallback) | 53 (88%) |
| Its `resource` exactly equals the server URL (Claude requires this) | 45 of 53 |
| Authorization server metadata found | 52 (87%) |
| PKCE `S256` advertised | 52 of 52 |
| Dynamic client registration / client ID metadata documents / either | 49 / 20 / 50 of 52 |
| `refresh_token` grant listed | 50 of 52 |
| **No Claude auth error** | **43 (72%)** |

Errors on the other 17: `resource` mismatch (8), no `resource_metadata` in the 401 (7), no resource metadata at all (7), no authorization server metadata (1), issuer mismatch (1). One server can have several.

### Tool definitions on the 119 public servers that listed tools (1,272 tools)

| Finding | Servers | Tools |
|---|---:|---:|
| ANN003: not all three ChatGPT hints are explicit | 71 (60%) | 743 |
| ANN012: read tool not marked read-only (Claude prompts on every call) | 59 (50%) | 241 |
| SCH002: undocumented input parameters (info) | 56 | 318 |
| ANN002: neither `readOnlyHint` nor `destructiveHint` (Claude requires one) | 54 (45%) | 407 |
| ANN001: no title (Claude requires one) | 36 (30%) | 371 |
| SCH003: parameter asks for an API key or password (ChatGPT forbids)* | 6 | 117 |
| SPL001: catch-all tool choosing reads and writes via an `action` argument | 4 | 5 |
| ANN010: marked read-only, but the name suggests a change (warnings, see below) | 3 | 4 |
| ANN015: send or purchase with `destructiveHint: false` | 3 | 5 |
| ANN011: cancel or unsubscribe with `destructiveHint: false` | 2 | 2 |
| DSC005: description tells the model not to confirm, on a tool that cancels bookings | 1 | 1 |
| DSC003: hidden text | **0** | **0** |

\* Checked by hand: 5 of the 6 servers really take an API key or password as a tool argument. The sixth names a parameter `drivers_license` that holds a status ("valid", "none"), not a number.

Per tool: 71% have a title, 68% have `readOnlyHint` or `destructiveHint`, and 42% have all three ChatGPT hints.

## Where the checker was wrong, and what changed

The first pass flagged 12 read-only tools whose names looked like writes or code execution. I read every one:

- **9 were false positives.**
  - Descriptions that say outright the tool changes nothing: "this tool writes nothing", "performs no external write".
  - Nouns read as verbs: `check_label_and_packaging`, `polymarket_fill_risk`.
  - French descriptions that start "Charge le guide…" (three tools).
  - A calculator that "evaluates" arithmetic, which isn't code execution.
  - An onboarding status tool named `onboard_start`.
- **The other 3 deserved a human look, not an error.** The clearest real case: a tool described as "Buy per-query access to live data listings" is marked `readOnlyHint: true`.

So in 0.2.0:
- `ANN010` is an **error only when the name and the description both describe a change**, and a warning otherwise.
- A description that says the tool is read-only, or writes nothing, suppresses it.
- Noun-like verbs (`fill`, `label`, `order`, `post`…) count only when they lead the tool name.
- The description fallback skips non-English text.
- The promotion rule no longer fires on "the best route" or a trading signal of "Buy now".
- `DSC005` is new: it flags text that tells the model to act without confirming, on tools that can change something. It was missed on a booking-cancellation tool whose description says "no confirmation step… do NOT re-ask".

Each of these cases is now a regression test (`test/rules.test.ts`, "calibration against real servers").

## Limits

- The sample covers registry **remote** servers only. Packages run locally (npm, PyPI, OCI) weren't included.
- Registry entries skew toward new and small publishers, so these numbers say nothing about any particular vendor.
- Everything here is static. Hint-presence findings are exact. "Name suggests a change" findings are heuristic, and were checked by hand before being counted.
- Passing these checks doesn't mean a directory will accept the server.
