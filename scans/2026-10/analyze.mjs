// Aggregates remote-results.json into the numbers published in this folder's README.
//   node scans/2026-10/analyze.mjs            print aggregates as JSON
//   node scans/2026-10/analyze.mjs --flagged  list the tool-level findings that need a human look
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { checkTools } from "../../dist/index.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const data = JSON.parse(await readFile(`${HERE}/remote-results.json`, "utf8"));
const rs = data.results;

// When raw tool definitions were re-listed (scan.mjs relist), re-apply the current rules to them.
let relisted = null;
try {
  relisted = JSON.parse(await readFile(`${HERE}/public-tools.json`, "utf8"));
} catch {
  relisted = null;
}
if (relisted) {
  const byUrl = new Map(relisted.map((s) => [s.url, s]));
  for (const r of rs) {
    const s = byUrl.get(r.url);
    if (!s) continue;
    if (s.tools.length === 0 && s.errors.length) {
      r.toolRows = null;
      r.toolFindings = null;
      r.toolCount = null;
      continue;
    }
    const { findings, rows } = checkTools(s.tools, ["claude", "chatgpt", "core"]);
    r.toolCount = s.tools.length;
    r.toolRows = rows;
    r.toolFindings = findings.map((f) => ({ ruleId: f.ruleId, severity: f.severity, profile: f.profile, tool: f.tool ?? null, evidence: f.evidence ?? null }));
    r.rawTools = s.tools;
  }
}

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(0)}%` : "n/a");
const count = (xs, f) => xs.filter(f).length;
const has = (r, id, sev) => (r.authFindings ?? []).some((f) => f.ruleId === id && (!sev || f.severity === sev));

const status = (r) => {
  const s = r.initializeStatus;
  if (s === null) return /timed out/.test(r.initializeError ?? "") ? "timeout" : "network-error";
  if (s >= 200 && s < 300) return "public-2xx";
  if (s === 401) return "401";
  if (s === 403) return "403";
  if (s === 404 || s === 405) return "404-405";
  if (s >= 500) return "5xx";
  return "other-4xx";
};

const byStatus = {};
for (const r of rs) byStatus[status(r)] = (byStatus[status(r)] ?? 0) + 1;

const protectedRs = rs.filter((r) => r.initializeStatus === 401 || r.initializeStatus === 403);
const withPrm = protectedRs.filter((r) => r.prmSource === "header" || r.prmSource === "well-known");
const withAs = protectedRs.filter((r) => r.asMetadataUrl);
const claudeAuthClean = protectedRs.filter((r) => !(r.authFindings ?? []).some((f) => f.severity === "error" && (f.profile === "claude" || f.profile === "core")));

const auth = {
  protected: protectedRs.length,
  resourceMetadataInHeader: `${count(protectedRs, (r) => r.prmSource === "header")} (${pct(count(protectedRs, (r) => r.prmSource === "header"), protectedRs.length)})`,
  prmFoundAnywhere: `${withPrm.length} (${pct(withPrm.length, protectedRs.length)})`,
  prmResourceExactMatch: `${count(withPrm, (r) => r.prmResource === r.url)} of ${withPrm.length}`,
  asMetadataFound: `${withAs.length} (${pct(withAs.length, protectedRs.length)})`,
  s256Advertised: `${count(withAs, (r) => (r.pkce ?? []).includes("S256"))} of ${withAs.length}`,
  dcr: `${count(withAs, (r) => r.dcr)} of ${withAs.length}`,
  cimd: `${count(withAs, (r) => r.cimd)} of ${withAs.length}`,
  dcrOrCimd: `${count(withAs, (r) => r.dcr || r.cimd)} of ${withAs.length}`,
  refreshGrantListed: `${count(withAs, (r) => (r.grants ?? []).includes("refresh_token"))} of ${count(withAs, (r) => Array.isArray(r.grants))} that list grants`,
  passesEveryClaudeAuthCheck: `${claudeAuthClean.length} (${pct(claudeAuthClean.length, protectedRs.length)})`,
  ruleCounts: Object.fromEntries(
    [...new Set(protectedRs.flatMap((r) => (r.authFindings ?? []).map((f) => `${f.ruleId}:${f.severity}`)))]
      .sort()
      .map((k) => [k, count(protectedRs, (r) => (r.authFindings ?? []).some((f) => `${f.ruleId}:${f.severity}` === k))]),
  ),
};

const listed = rs.filter((r) => Array.isArray(r.toolRows));
const withTools = listed.filter((r) => r.toolCount > 0);
const rows = withTools.flatMap((r) => r.toolRows);
const serversWith = (id) => count(withTools, (r) => (r.toolFindings ?? []).some((f) => f.ruleId === id));
const toolsWith = (id) => withTools.reduce((n, r) => n + new Set((r.toolFindings ?? []).filter((f) => f.ruleId === id).map((f) => f.tool)).size, 0);

const tools = {
  publicServersListed: listed.length,
  publicServersWithTools: withTools.length,
  toolsChecked: rows.length,
  toolsWithTitle: `${count(rows, (t) => t.title)} (${pct(count(rows, (t) => t.title), rows.length)})`,
  toolsWithReadOnlyOrDestructive: `${count(rows, (t) => t.readOnlyHint !== undefined || t.destructiveHint !== undefined)} (${pct(count(rows, (t) => t.readOnlyHint !== undefined || t.destructiveHint !== undefined), rows.length)})`,
  toolsWithAllThreeChatgptHints: `${count(rows, (t) => t.readOnlyHint !== undefined && t.destructiveHint !== undefined && t.openWorldHint !== undefined)} (${pct(count(rows, (t) => t.readOnlyHint !== undefined && t.destructiveHint !== undefined && t.openWorldHint !== undefined), rows.length)})`,
  serversWithNoClaudeErrors: `${count(withTools, (r) => !(r.toolFindings ?? []).some((f) => f.severity === "error" && f.profile === "claude"))} of ${withTools.length}`,
  serversWithNoChatgptErrors: `${count(withTools, (r) => !(r.toolFindings ?? []).some((f) => f.severity === "error" && f.profile === "chatgpt"))} of ${withTools.length}`,
  serversWithNoErrorsAnyProfile: `${count(withTools, (r) => !(r.toolFindings ?? []).some((f) => f.severity === "error"))} of ${withTools.length}`,
  rules: Object.fromEntries(
    [...new Set(withTools.flatMap((r) => (r.toolFindings ?? []).map((f) => f.ruleId)))].sort().map((id) => [id, { servers: serversWith(id), tools: toolsWith(id) }]),
  ),
  inferredEffects: Object.fromEntries(["read", "write", "destructive", "send", "exec", "unknown"].map((e) => [e, count(rows, (t) => t.inferredEffect === e)])),
};

if (process.argv.includes("--sample")) {
  // handled below
} else if (process.argv.includes("--flagged")) {
  for (const r of withTools) {
    for (const f of r.toolFindings ?? []) {
      if (["ANN010", "ANN011", "ANN015", "DSC002", "DSC003", "DSC004", "DSC005", "SPL001", "SCH003"].includes(f.ruleId)) {
        const raw = (r.rawTools ?? []).find((t) => t.name === f.tool);
        const desc = typeof raw?.description === "string" ? raw.description.replace(/\s+/g, " ").slice(0, 160) : "";
        console.log(`${f.ruleId}\t${f.severity}\t${r.host}\t${f.tool}\t${f.evidence ?? ""}\t${desc}`);
      }
    }
  }
} else {
  console.log(JSON.stringify({ scannedAt: data.scannedAt, registryFetchedAt: data.registryFetchedAt, eligible: data.eligible, sampled: data.sampled, byStatus, auth, tools }, null, 2));
}

if (process.argv.includes("--sample")) {
  // The sampled servers and how each answered an unauthenticated initialize. No per-server findings.
  console.log("registry_name,url,unauthenticated_initialize");
  for (const r of rs) console.log([r.name, r.url, r.initializeStatus ?? "no-response"].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
}
