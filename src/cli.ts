#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { probeAuth } from "./auth.js";
import { inspectHttp, inspectStdio } from "./inspect.js";
import { buildReport, hasFindingsAtOrAbove, renderJson, renderMarkdown, renderText } from "./report.js";
import { ALL_PROFILES, type Profile, type Severity } from "./types.js";
import { VERSION } from "./version.js";

const USAGE = `mcp-readiness ${VERSION}
Check an MCP server against the Claude Connectors Directory and ChatGPT app directory rules.

Usage:
  mcp-readiness [options] -- <command> [args...]    check a local server over stdio
  mcp-readiness [options] --url <https://...>       check a remote server (Streamable HTTP)

Options:
  --url <url>              Remote server URL. Runs the OAuth discovery probe (no credentials sent).
  --header "Name: value"   Extra HTTP header for listing tools, e.g. an Authorization header. Repeatable.
  --env KEY=VALUE          Environment variable for a stdio server. Repeatable.
  --cwd <dir>              Working directory for a stdio server.
  --profile <list>         claude,chatgpt,core (default: all three).
  --format <fmt>           text | markdown | json (default: text).
  --out <file>             Write the report to a file instead of stdout.
  --fail-on <level>        error | warning | info | never (default: error). Sets the exit code for CI.
  --timeout <ms>           Per-request timeout (default: 60000 stdio, 15000 http).
  --no-auth-probe          Skip OAuth discovery for --url targets.
  -h, --help               Show this help.
  -v, --version            Print the version.

Exit codes: 0 = no findings at or above --fail-on, 1 = findings, 2 = could not run.
Only tools/list is read. No tool is ever called.`;

export interface CliResult {
  exitCode: number;
  output: string;
}

function parseKeyValues(values: string[] | undefined, sep: string, what: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of values ?? []) {
    const i = v.indexOf(sep);
    if (i <= 0) throw new UsageError(`${what} must look like ${what === "--header" ? '"Name: value"' : "KEY=VALUE"}: ${v}`);
    out[v.slice(0, i).trim()] = v.slice(i + sep.length).trim();
  }
  return out;
}

class UsageError extends Error {}

export async function run(argv: string[]): Promise<CliResult> {
  const dash = argv.indexOf("--");
  const own = dash >= 0 ? argv.slice(0, dash) : argv;
  const command = dash >= 0 ? argv.slice(dash + 1) : [];

  let values;
  try {
    ({ values } = parseArgs({
      args: own,
      options: {
        url: { type: "string" },
        header: { type: "string", multiple: true },
        env: { type: "string", multiple: true },
        cwd: { type: "string" },
        profile: { type: "string" },
        format: { type: "string", default: "text" },
        out: { type: "string" },
        "fail-on": { type: "string", default: "error" },
        timeout: { type: "string" },
        "no-auth-probe": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    return { exitCode: 2, output: `${err instanceof Error ? err.message : String(err)}\n\n${USAGE}` };
  }

  if (values.help) return { exitCode: 0, output: USAGE };
  if (values.version) return { exitCode: 0, output: VERSION };

  try {
    if (!values.url && command.length === 0) throw new UsageError("Give either --url <url> or -- <command> [args...].");
    if (values.url && command.length > 0) throw new UsageError("Give --url or a stdio command, not both.");

    const profiles = (values.profile ? values.profile.split(",").map((p) => p.trim()) : [...ALL_PROFILES]) as Profile[];
    const bad = profiles.filter((p) => !ALL_PROFILES.includes(p));
    if (bad.length) throw new UsageError(`Unknown profile: ${bad.join(", ")}`);

    const format = values.format;
    if (!["text", "markdown", "md", "json"].includes(format)) throw new UsageError(`Unknown format: ${format}`);
    const failOn = values["fail-on"];
    if (!["error", "warning", "info", "never"].includes(failOn)) throw new UsageError(`Unknown --fail-on level: ${failOn}`);
    const timeoutMs = values.timeout ? Number(values.timeout) : undefined;
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new UsageError(`Bad --timeout: ${values.timeout}`);

    let inspection;
    if (values.url) {
      try {
        new URL(values.url);
      } catch {
        throw new UsageError(`Not a URL: ${values.url}`);
      }
      const headers = parseKeyValues(values.header, ":", "--header");
      inspection = await inspectHttp({ url: values.url, headers }, { timeoutMs });
      if (!values["no-auth-probe"]) inspection.auth = await probeAuth(values.url);
    } else {
      const env = parseKeyValues(values.env, "=", "--env");
      const [cmd, ...args] = command as [string, ...string[]];
      inspection = await inspectStdio({ command: cmd, args, env, cwd: values.cwd }, { timeoutMs });
    }

    const report = buildReport(inspection, profiles);
    const output = format === "json" ? renderJson(report) : format === "text" ? renderText(report) : renderMarkdown(report);

    const couldNotRun = inspection.tools.length === 0 && !inspection.toolsUnavailable && !inspection.auth && inspection.errors.length > 0;
    const exitCode = couldNotRun ? 2 : failOn !== "never" && hasFindingsAtOrAbove(report, failOn as Severity) ? 1 : 0;

    if (values.out) {
      await writeFile(values.out, output, "utf8");
      return { exitCode, output: `Report written to ${values.out}` };
    }
    return { exitCode, output };
  } catch (err) {
    if (err instanceof UsageError) return { exitCode: 2, output: `${err.message}\n\n${USAGE}` };
    throw err;
  }
}

/** npm runs bins through a symlink (POSIX) or a .cmd shim (Windows), so compare real paths. */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  run(process.argv.slice(2)).then(
    ({ exitCode, output }) => {
      process.stdout.write(output.endsWith("\n") ? output : output + "\n");
      process.exitCode = exitCode;
    },
    (err: unknown) => {
      process.stderr.write(`mcp-readiness failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exitCode = 2;
    },
  );
}
