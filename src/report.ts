import { checkAuth } from "./auth.js";
import { checkTools } from "./rules.js";
import { VERSION } from "./version.js";
import { SEVERITY_ORDER, type Finding, type Inspection, type Profile, type Report, type Severity } from "./types.js";

const PROFILE_LABEL: Record<Profile, string> = {
  claude: "Claude Connectors Directory",
  chatgpt: "ChatGPT app directory",
  core: "MCP spec and hygiene",
};

export function buildReport(inspection: Inspection, profiles: Profile[]): Report {
  const { findings: toolFindings, rows } = checkTools(inspection.tools, profiles);
  const authFindings = inspection.auth ? checkAuth(inspection.auth, profiles) : [];
  const findings = [...authFindings, ...toolFindings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.ruleId.localeCompare(b.ruleId) || (a.tool ?? "").localeCompare(b.tool ?? ""),
  );

  const summary = {} as Report["summary"];
  for (const p of ["claude", "chatgpt", "core"] as Profile[]) summary[p] = { error: 0, warning: 0, info: 0 };
  for (const f of findings) summary[f.profile][f.severity]++;

  return {
    tool: { name: "mcp-readiness", version: VERSION },
    checkedAt: new Date().toISOString(),
    target: inspection.target,
    server: inspection.server,
    profiles,
    toolCount: inspection.tools.length,
    toolsUnavailable: inspection.toolsUnavailable,
    findings,
    summary,
    toolTable: rows,
    auth: inspection.auth,
    errors: inspection.errors,
  };
}

export function hasFindingsAtOrAbove(report: Report, threshold: Severity): boolean {
  return report.findings.some((f) => SEVERITY_ORDER[f.severity] <= SEVERITY_ORDER[threshold]);
}

function targetLabel(report: Report): string {
  return report.target.kind === "http" ? report.target.url : [report.target.command, ...report.target.args].join(" ");
}

function counts(c: Record<Severity, number>): string {
  const parts = [`${c.error} error${c.error === 1 ? "" : "s"}`, `${c.warning} warning${c.warning === 1 ? "" : "s"}`];
  if (c.info) parts.push(`${c.info} info`);
  return parts.join(", ");
}

function verdict(report: Report, p: Profile): string {
  const c = report.summary[p];
  if (report.toolsUnavailable && report.toolCount === 0) return `${counts(c)} (tools not checked)`;
  return c.error === 0 ? `ready (${counts(c)})` : `not ready (${counts(c)})`;
}

const hint = (v: boolean | undefined) => (v === undefined ? "-" : v ? "yes" : "no");

export function renderText(report: Report): string {
  const lines: string[] = [];
  lines.push(`mcp-readiness ${report.tool.version}: ${targetLabel(report)}`);
  if (report.server) lines.push(`Server: ${report.server.name ?? "?"} ${report.server.version ?? ""}`.trimEnd());
  lines.push(`Tools: ${report.toolsUnavailable ? `not listed (${report.toolsUnavailable})` : report.toolCount}`);
  lines.push("");
  lines.push("Verdict");
  for (const p of report.profiles) lines.push(`  ${PROFILE_LABEL[p].padEnd(28)} ${verdict(report, p)}`);

  if (report.errors.length) {
    lines.push("", "Problems while checking");
    for (const e of report.errors) lines.push(`  ! ${e}`);
  }

  if (report.findings.length) {
    lines.push("", "Findings");
    for (const f of report.findings) {
      lines.push(`  ${f.severity.toUpperCase().padEnd(7)} ${f.ruleId} [${f.profile}]${f.tool ? ` ${f.tool}:` : ""} ${f.message}`);
      if (f.evidence) lines.push(`          evidence: ${f.evidence}`);
      lines.push(`          source:   ${f.reference}`);
    }
  }

  if (report.toolTable.length) {
    lines.push("", "Annotation truth table (declared hints vs. what the name implies)");
    const w = Math.min(40, Math.max(4, ...report.toolTable.map((r) => r.name.length)));
    lines.push(`  ${"tool".padEnd(w)}  title  readOnly  destructive  idempotent  openWorld  implies      rules`);
    for (const r of report.toolTable) {
      lines.push(
        `  ${r.name.slice(0, w).padEnd(w)}  ${(r.title ? "yes" : "-").padEnd(5)}  ${hint(r.readOnlyHint).padEnd(8)}  ${hint(r.destructiveHint).padEnd(11)}  ${hint(r.idempotentHint).padEnd(10)}  ${hint(r.openWorldHint).padEnd(9)}  ${r.inferredEffect.padEnd(11)}  ${r.findings.join(" ")}`,
      );
    }
  }

  if (report.auth) lines.push("", ...authSummary(report).map((l) => `  ${l}`));
  lines.push("", "Static checks only: no tool was called. A clean report is not a directory approval.");
  return lines.join("\n");
}

function authSummary(report: Report): string[] {
  const a = report.auth;
  if (!a) return [];
  const out = ["Auth discovery (no credentials sent)"];
  out.push(`unauthenticated initialize: ${a.initializeStatus ?? a.initializeError ?? "?"}`);
  if (a.wwwAuthenticate) out.push(`WWW-Authenticate: ${a.wwwAuthenticate}`);
  if (a.prmUrl) out.push(`protected resource metadata: ${a.prmUrl} (found via ${a.prmSource})`);
  if (a.authorizationServer) out.push(`authorization server: ${a.authorizationServer}`);
  if (a.asMetadataUrl) out.push(`authorization server metadata: ${a.asMetadataUrl}`);
  return out;
}

const md = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderMarkdown(report: Report): string {
  const lines: string[] = [];
  lines.push(`# MCP readiness report`, "");
  lines.push(`- **Target:** \`${md(targetLabel(report))}\``);
  if (report.server) lines.push(`- **Server:** ${md(`${report.server.name ?? "?"} ${report.server.version ?? ""}`.trim())}`);
  lines.push(`- **Tools:** ${report.toolsUnavailable ? `not listed (${md(report.toolsUnavailable)})` : report.toolCount}`);
  lines.push(`- **Checked:** ${report.checkedAt} with mcp-readiness ${report.tool.version}`, "");

  lines.push("| Directory | Verdict |", "|---|---|");
  for (const p of report.profiles) lines.push(`| ${PROFILE_LABEL[p]} | ${verdict(report, p)} |`);

  if (report.errors.length) {
    lines.push("", "## Problems while checking", "");
    for (const e of report.errors) lines.push(`- ${md(e)}`);
  }

  if (report.findings.length) {
    lines.push("", "## Findings", "", "| Severity | Rule | Directory | Tool | Finding | Evidence |", "|---|---|---|---|---|---|");
    for (const f of report.findings) {
      lines.push(`| ${f.severity} | [${f.ruleId}](${f.reference}) | ${f.profile} | ${f.tool ? `\`${md(f.tool)}\`` : ""} | ${md(f.message)} | ${f.evidence ? `\`${md(f.evidence)}\`` : ""} |`);
    }
  }

  if (report.toolTable.length) {
    lines.push("", "## Annotation truth table", "", "Declared hints next to what the tool name implies.", "");
    lines.push("| Tool | Title | readOnly | destructive | idempotent | openWorld | Name implies | Rules |", "|---|---|---|---|---|---|---|---|");
    for (const r of report.toolTable) {
      lines.push(`| \`${md(r.name)}\` | ${r.title ? "yes" : "-"} | ${hint(r.readOnlyHint)} | ${hint(r.destructiveHint)} | ${hint(r.idempotentHint)} | ${hint(r.openWorldHint)} | ${r.inferredEffect} | ${r.findings.join(" ")} |`);
    }
  }

  if (report.auth) {
    lines.push("", "## Auth discovery", "", ...authSummary(report).slice(1).map((l) => `- ${md(l)}`));
  }
  lines.push("", "_Static checks only: no tool was called. A clean report is not a directory approval._");
  return lines.join("\n") + "\n";
}

export function renderJson(report: Report): string {
  return JSON.stringify(report, null, 2) + "\n";
}

export type { Finding };
