# mcp-readiness

[![ci](https://github.com/alijahak/mcp-readiness/actions/workflows/ci.yml/badge.svg)](https://github.com/alijahak/mcp-readiness/actions/workflows/ci.yml)

Check an MCP server against the **Claude Connectors Directory** and **ChatGPT app directory** rules before you submit it.

It connects to your server and reads `tools/list`. It **never calls a tool**. Then it checks what reviewers check: tool titles and annotations, whether the hints match what each tool does, read/write split, description hygiene (including hidden-text tool poisoning), input schemas, and, for remote servers, the OAuth discovery chain a client walks before sign-in.

```
$ npx github:alijahak/mcp-readiness -- node my-server.js

Verdict
  Claude Connectors Directory  not ready (4 errors, 1 warning)
  ChatGPT app directory        not ready (2 errors, 0 warnings)
  MCP spec and hygiene         not ready (2 errors, 1 warning, 1 info)

Findings
  ERROR   ANN010 [core] create_ticket: Marked readOnlyHint: true, but both the name and the description
          say it changes data. Claude can run read-only tools without asking the user.
          evidence: verb: create
  ERROR   SPL001 [claude] api_request: One tool does both reads and writes, selected by "method".
          evidence: method: GET | POST | DELETE
  ...
Annotation truth table (declared hints vs. what the name implies)
  tool            title  readOnly  destructive  idempotent  openWorld  implies      rules
  get_forecast    yes    yes       no           yes         yes        read
  create_ticket   yes    yes       no           -           no         write        ANN010
  delete_ticket   -      -         -            -           -          destructive  ANN001 ANN002 ANN003
```

## Why the hints matter

Annotations aren't decoration:

- **Claude** runs tools marked `readOnlyHint: true` without asking for per-call confirmation, and always prompts for destructive ones. A write tool labelled read-only skips the user's approval.
- **Claude's review** requires a `title` and the applicable `readOnlyHint` or `destructiveHint` on every tool. It also rejects catch-all "method" tools and descriptions that instruct the model.
- **ChatGPT's submission guidelines** require explicit booleans for `readOnlyHint`, `destructiveHint` and `openWorldHint`. They count irreversible sends and transactions as destructive.

## Usage

```bash
# local server over stdio: everything after -- is the command
npx github:alijahak/mcp-readiness -- npx -y @your-org/your-mcp-server
npx github:alijahak/mcp-readiness --env API_KEY=dummy -- python -m your_server

# remote server: runs the OAuth discovery probe (no credentials are sent)
npx github:alijahak/mcp-readiness --url https://mcp.example.com/mcp

# remote server's tools, with a token you supply
npx github:alijahak/mcp-readiness --url https://mcp.example.com/mcp --header "Authorization: Bearer $TOKEN"
```

| Option | |
|---|---|
| `--profile claude,chatgpt,core` | Which rule sets to apply (default: all) |
| `--format text\|markdown\|json` | Report format (default: text) |
| `--out report.md` | Write to a file |
| `--fail-on error\|warning\|info\|never` | Exit code threshold for CI (default: error) |
| `--timeout <ms>` | Per-request timeout |
| `--no-auth-probe` | Skip OAuth discovery for `--url` |

Exit codes: `0` nothing at or above `--fail-on`, `1` findings, `2` could not run.

### In CI

```yaml
- run: npx -y github:alijahak/mcp-readiness --format markdown --out readiness.md -- node dist/server.js
- run: cat readiness.md >> "$GITHUB_STEP_SUMMARY"
  if: always()
```

## Rules

Each finding links to the published requirement it comes from.

| Rule | Severity | Directory | Checks |
|---|---|---|---|
| ANN001 | error | Claude | Every tool has a `title` (top-level or `annotations.title`) |
| ANN002 | error | Claude | Every tool sets `readOnlyHint` or `destructiveHint` |
| ANN003 | error | ChatGPT | `readOnlyHint`, `destructiveHint` and `openWorldHint` are all explicit booleans |
| ANN004 | error | core | Hints are booleans, not strings |
| ANN005 | warning | Claude | Write tools set `destructiveHint` deliberately (the default is `true`) |
| ANN010 | error/warning | core | A tool that creates, updates, deletes or sends is not marked `readOnlyHint: true`. Error when the name and description both say so; warning on one signal, or for exec/query tools (read-only only if the server enforces it). A description that says the tool writes nothing suppresses it. |
| ANN011 | warning | core | Delete/cancel/overwrite tools don't set `destructiveHint: false` |
| ANN012 | info | core | Read tools set `readOnlyHint: true`, or Claude prompts on every call |
| ANN013 | warning | core | `readOnlyHint: true` with `destructiveHint: true` is contradictory |
| ANN015 | warning | ChatGPT | Send/pay/publish tools don't set `destructiveHint: false` |
| NAM001 | error | Claude | Tool names are at most 64 characters |
| NAM002 | warning | core | Tool names use `A-Z a-z 0-9 _ - .`, 1-128 characters (MCP spec 2025-11-25) |
| NAM003 | error | core | Tool names are unique |
| SPL001 | error/warning | Claude | No catch-all tools that pick reads or writes via a `method`/`action` argument |
| DSC001 | warning | core | Every tool has a real description |
| DSC002 | warning | Claude | Descriptions (and parameter descriptions) don't instruct the model ("always call this tool first", `<IMPORTANT>` tags, "don't tell the user") |
| DSC003 | error | core | No hidden text: zero-width or bidi characters, Unicode tag characters, HTML comments |
| DSC004 | warning | Claude | No promotional language |
| DSC005 | warning | core | No text telling the model to act without asking the user ("no confirmation step", "do not re-ask") on tools that can change something |
| SCH001 | error | core | `inputSchema` is an object schema |
| SCH002 | info | core | Input parameters have descriptions |
| SCH003 | error | ChatGPT | No free-text parameters asking for passwords, API keys, card numbers or government IDs |
| AUT000 | info | core | Server accepts unauthenticated requests (fine for public data only) |
| AUT001 | error | Claude | A 401 carries `WWW-Authenticate` with `resource_metadata` |
| AUT002 | error | Claude | Protected resource metadata (RFC 9728) exists and lists `authorization_servers` |
| AUT003 | error | Claude | The metadata's `resource` exactly equals the server URL |
| AUT004 | error | Claude | Authorization server metadata (RFC 8414 or OpenID discovery) is reachable |
| AUT005 | error | Claude | PKCE `S256` is advertised in `code_challenge_methods_supported` |
| AUT006 | warning | Claude | Dynamic client registration or client ID metadata documents are advertised |
| AUT007 | error/warning | Claude | `authorization_code` and `refresh_token` grants are supported |
| AUT008 | error | Claude | Discovery endpoints answer within 10 s |
| AUT009 | error | core | Remote servers use HTTPS |
| AUT010 | error | core | Metadata `issuer` matches the authorization server identifier |
| AUT011/012 | warning | Claude | Streamable HTTP is accepted; unauthenticated calls get 401, not 403 |

Sources:
- [Claude connector review criteria](https://claude.com/docs/connectors/building/review-criteria)
- [Claude connector authentication](https://claude.com/docs/connectors/building/authentication)
- [ChatGPT app submission guidelines](https://developers.openai.com/apps-sdk/app-submission-guidelines)
- [MCP spec: tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [MCP spec: authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728) and [RFC 8414](https://www.rfc-editor.org/rfc/rfc8414)

These rules were read from those pages on 2026-09-30. Directories change their rules; open an issue if one has moved.

## Real-world results

[October 2026 scan of 200 servers from the official MCP Registry](scans/2026-10/README.md):

- Only **31%** of public servers had no directory-blocking finding.
- **60%** were missing ChatGPT's required hints on at least one tool.
- **72%** of OAuth-protected servers passed every Claude auth check.

The page also covers the 9 false positives the first pass produced, and how the rules changed because of them.

## What it does not check

- **Behaviour.** "What the name implies" is a word-level heuristic (`list_orders` is a read, `create_order` a write). It points a human at likely mislabels. Only calling the tool against a test account proves what it does, and this tool never calls one.
- **Tenant isolation.** Whether one customer can read another's data needs two real accounts.
- **The full OAuth flow.** It checks discovery and metadata. It does not sign in, register a client, or test token refresh.
- **Listing requirements** such as privacy policy, demo account, icons and support contact.

A clean report means none of these checks fired. It does not mean a directory will accept the server.

## Library use

```ts
import { inspectStdio, probeAuth, buildReport, renderMarkdown } from "mcp-readiness";

const inspection = await inspectStdio({ command: "node", args: ["server.js"] });
const report = buildReport(inspection, ["claude", "chatgpt", "core"]);
console.log(renderMarkdown(report));
```

## Development

```bash
npm install
npm test        # vitest: rule unit tests, a local OAuth-discovery server, and an end-to-end stdio run
npm run build
```

`test/fixtures/stdio-fixture.mjs` is a server with one tool per kind of mistake plus one clean tool. The end-to-end test checks that every mistake is found and that the clean tool gets no findings.

## License

MIT
