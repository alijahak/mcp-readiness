// Scan of remote MCP servers listed in the official MCP Registry.
//
//   node scans/2026-10/scan.mjs snapshot          fetch the registry (latest versions) to registry-snapshot.json
//   node scans/2026-10/scan.mjs remote [N]        probe a seeded random sample of N remote servers (default 200)
//
// What each probe does, per server: one unauthenticated `initialize` POST, then (on 401) the protected
// resource metadata and authorization server metadata GETs a client makes before sign-in. If the server
// is public (200), it also lists tools. No credentials are sent and no tool is ever called.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { checkAuth, checkTools, inspectHttp, probeAuth } from "../../dist/index.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REGISTRY = "https://registry.modelcontextprotocol.io/v0/servers";
const UA = "mcp-readiness/0.2.0 scan (+https://github.com/alijahak/mcp-readiness)";
const PROFILES = ["claude", "chatgpt", "core"];

async function snapshot() {
  const servers = [];
  let cursor;
  for (let page = 0; page < 500; page++) {
    const url = new URL(REGISTRY);
    url.searchParams.set("limit", "100");
    url.searchParams.set("version", "latest");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`registry ${res.status} at page ${page}`);
    const body = await res.json();
    for (const s of body.servers ?? []) servers.push(s.server);
    cursor = body.metadata?.nextCursor;
    if (!cursor) break;
  }
  const out = { fetchedAt: new Date().toISOString(), source: `${REGISTRY}?version=latest`, count: servers.length, servers };
  await writeFile(`${HERE}/registry-snapshot.json`, JSON.stringify(out));
  const remotes = servers.filter((s) => s.remotes?.length).length;
  const packages = servers.filter((s) => s.packages?.length).length;
  console.log(`snapshot: ${servers.length} servers, ${remotes} with remotes, ${packages} with packages`);
}

/** Deterministic PRNG so the sample can be reproduced from the snapshot. */
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function eligibleRemotes(servers) {
  const seen = new Set();
  const out = [];
  for (const s of servers) {
    const remote = (s.remotes ?? []).find((r) => r.type === "streamable-http" && typeof r.url === "string");
    if (!remote) continue;
    if (/[{}]/.test(remote.url)) continue; // URL templates need per-user values
    if ((remote.headers ?? []).some((h) => h.isRequired)) continue; // needs an API key header just to connect
    let host;
    try {
      const u = new URL(remote.url);
      if (u.protocol !== "https:") continue;
      host = u.host;
    } catch {
      continue;
    }
    if (seen.has(remote.url)) continue;
    seen.add(remote.url);
    out.push({ name: s.name, title: s.title, version: s.version, url: remote.url, host });
  }
  return out;
}

async function pool(items, size, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }));
  return results;
}

async function scanRemote(n) {
  const snap = JSON.parse(await readFile(`${HERE}/registry-snapshot.json`, "utf8"));
  const pool_ = eligibleRemotes(snap.servers);
  const rand = mulberry32(20261002);
  const shuffled = pool_.map((x) => [rand(), x]).sort((a, b) => a[0] - b[0]).map(([, x]) => x);
  // At most one endpoint per host, so no single operator is probed repeatedly.
  const perHost = new Set();
  const sample = [];
  for (const s of shuffled) {
    if (perHost.has(s.host)) continue;
    perHost.add(s.host);
    sample.push(s);
    if (sample.length >= n) break;
  }
  console.log(`eligible remotes: ${pool_.length}; distinct hosts sampled: ${sample.length}`);

  const results = await pool(sample, 8, async (s, i) => {
    const started = Date.now();
    const probe = await probeAuth(s.url, { timeoutMs: 10_000 });
    const record = {
      ...s,
      initializeStatus: probe.initializeStatus ?? null,
      initializeError: probe.initializeError ?? null,
      prmSource: probe.prmSource ?? null,
      prmResource: typeof probe.prm?.resource === "string" ? probe.prm.resource : null,
      authorizationServer: probe.authorizationServer ?? null,
      asMetadataUrl: probe.asMetadataUrl ?? null,
      pkce: Array.isArray(probe.asMetadata?.code_challenge_methods_supported) ? probe.asMetadata.code_challenge_methods_supported : null,
      dcr: typeof probe.asMetadata?.registration_endpoint === "string",
      cimd: probe.asMetadata?.client_id_metadata_document_supported === true,
      grants: Array.isArray(probe.asMetadata?.grant_types_supported) ? probe.asMetadata.grant_types_supported : null,
      authFindings: checkAuth(probe, PROFILES).map((f) => ({ ruleId: f.ruleId, severity: f.severity, profile: f.profile, evidence: f.evidence ?? null })),
      toolCount: null,
      toolFindings: null,
      toolRows: null,
      inspectErrors: [],
    };
    if (probe.initializeStatus !== undefined && probe.initializeStatus >= 200 && probe.initializeStatus < 300) {
      const inspection = await inspectHttp({ url: s.url, headers: { "user-agent": UA } }, { timeoutMs: 15_000 });
      record.inspectErrors = inspection.errors;
      if (inspection.tools.length || !inspection.errors.length) {
        const { findings, rows } = checkTools(inspection.tools, PROFILES);
        record.toolCount = inspection.tools.length;
        record.toolFindings = findings.map((f) => ({ ruleId: f.ruleId, severity: f.severity, profile: f.profile, tool: f.tool ?? null, evidence: f.evidence ?? null }));
        record.toolRows = rows;
      }
    }
    record.ms = Date.now() - started;
    process.stdout.write(`[${i + 1}/${sample.length}] ${s.host} -> ${record.initializeStatus ?? record.initializeError}${record.toolCount !== null ? ` tools=${record.toolCount}` : ""}\n`);
    return record;
  });

  await mkdir(`${HERE}`, { recursive: true });
  await writeFile(`${HERE}/remote-results.json`, JSON.stringify({ scannedAt: new Date().toISOString(), registryFetchedAt: snap.fetchedAt, eligible: pool_.length, sampled: sample.length, seed: 20261002, results }, null, 1));
  console.log("wrote remote-results.json");
}

/**
 * Re-lists tools for the public servers in remote-results.json and keeps the raw definitions, so rule
 * changes can be re-applied without probing anyone's auth endpoints again. Lists tools only; calls nothing.
 */
async function relist() {
  const data = JSON.parse(await readFile(`${HERE}/remote-results.json`, "utf8"));
  const publicOnes = data.results.filter((r) => r.initializeStatus >= 200 && r.initializeStatus < 300);
  const out = await pool(publicOnes, 8, async (r, i) => {
    const inspection = await inspectHttp({ url: r.url, headers: { "user-agent": UA } }, { timeoutMs: 15_000 });
    process.stdout.write(`[${i + 1}/${publicOnes.length}] ${r.host} tools=${inspection.tools.length}\n`);
    const tools = inspection.tools.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations }));
    return { host: r.host, url: r.url, name: r.name, listedAt: new Date().toISOString(), errors: inspection.errors, tools };
  });
  await writeFile(`${HERE}/public-tools.json`, JSON.stringify(out));
  console.log(`wrote public-tools.json (${out.reduce((n, s) => n + s.tools.length, 0)} tools)`);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "snapshot") await snapshot();
else if (cmd === "remote") await scanRemote(Number(arg ?? 200));
else if (cmd === "relist") await relist();
else {
  console.error("usage: scan.mjs snapshot | remote [N] | relist");
  process.exitCode = 2;
}
