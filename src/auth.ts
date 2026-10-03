import { REFS } from "./rules.js";
import { VERSION, USER_AGENT } from "./version.js";
import type { AuthProbe, Finding, HttpExchange, Profile } from "./types.js";

/** Claude requires discovery, registration and token endpoints to answer within 10 s. */
export const DISCOVERY_BUDGET_MS = 10_000;

interface ProbeOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function timed(
  exchanges: HttpExchange[],
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response | undefined> {
  const started = Date.now();
  const entry: HttpExchange = { url, method: init.method ?? "GET", ms: 0 };
  exchanges.push(entry);
  try {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    entry.status = res.status;
    entry.ms = Date.now() - started;
    return res;
  } catch (err) {
    entry.ms = Date.now() - started;
    entry.error = err instanceof Error ? (err.name === "TimeoutError" ? `timed out after ${timeoutMs} ms` : err.message) : String(err);
    return undefined;
  }
}

async function getJson(
  exchanges: HttpExchange[],
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<Record<string, unknown> | undefined> {
  const res = await timed(exchanges, fetchImpl, url, {
    method: "GET",
    headers: { accept: "application/json", "user-agent": USER_AGENT },
  }, timeoutMs);
  if (!res) return undefined;
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return undefined;
  }
  try {
    const body: unknown = await res.json();
    return isObject(body) ? body : undefined;
  } catch {
    const last = exchanges[exchanges.length - 1];
    if (last) last.error = "response was not JSON";
    return undefined;
  }
}

/** Pulls `resource_metadata` out of a `WWW-Authenticate: Bearer ...` header (quoted or bare). */
export function parseResourceMetadata(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  const m = /resource_metadata\s*=\s*(?:"([^"]+)"|([^\s,]+))/i.exec(header);
  return m?.[1] ?? m?.[2];
}

/** RFC 9728 well-known locations: path-inserted first, then the origin root. */
export function prmCandidates(serverUrl: string): string[] {
  const u = new URL(serverUrl);
  const path = u.pathname.replace(/\/+$/, "");
  const out = [];
  if (path) out.push(`${u.origin}/.well-known/oauth-protected-resource${path}`);
  out.push(`${u.origin}/.well-known/oauth-protected-resource`);
  return out;
}

/** Authorization server metadata locations, in the order the MCP authorization spec tells clients to try them. */
export function asMetadataCandidates(issuer: string): string[] {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/+$/, "");
  if (path) {
    return [
      `${u.origin}/.well-known/oauth-authorization-server${path}`,
      `${u.origin}/.well-known/openid-configuration${path}`,
      `${u.origin}${path}/.well-known/openid-configuration`,
    ];
  }
  return [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`];
}

/**
 * Does what a client does before sign-in: an unauthenticated `initialize`, then protected resource metadata
 * (RFC 9728), then authorization server metadata (RFC 8414 / OpenID discovery). Sends no credentials.
 */
export async function probeAuth(serverUrl: string, opts: ProbeOptions = {}): Promise<AuthProbe> {
  const timeoutMs = opts.timeoutMs ?? DISCOVERY_BUDGET_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const probe: AuthProbe = { serverUrl, exchanges: [] };

  const res = await timed(probe.exchanges, fetchImpl, serverUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "user-agent": USER_AGENT,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "mcp-readiness", version: VERSION } },
    }),
  }, timeoutMs);

  if (!res) {
    probe.initializeError = probe.exchanges[0]?.error ?? "no response";
    return probe;
  }
  probe.initializeStatus = res.status;
  probe.wwwAuthenticate = res.headers.get("www-authenticate") ?? undefined;
  const sessionId = res.headers.get("mcp-session-id");
  // Never read the body: an SSE response can stay open indefinitely.
  await res.body?.cancel().catch(() => undefined);

  if (res.ok) {
    if (sessionId) {
      // Be a polite client: end the session we just opened.
      await timed(probe.exchanges, fetchImpl, serverUrl, {
        method: "DELETE",
        headers: { "mcp-session-id": sessionId, "user-agent": USER_AGENT },
      }, timeoutMs).then((r) => r?.body?.cancel().catch(() => undefined));
    }
    return probe;
  }
  if (res.status !== 401 && res.status !== 403) return probe;

  probe.resourceMetadataUrl = parseResourceMetadata(probe.wwwAuthenticate);
  const candidates = probe.resourceMetadataUrl ? [probe.resourceMetadataUrl] : prmCandidates(serverUrl);
  for (const url of candidates) {
    const prm = await getJson(probe.exchanges, fetchImpl, url, timeoutMs);
    if (prm) {
      probe.prm = prm;
      probe.prmUrl = url;
      probe.prmSource = probe.resourceMetadataUrl ? "header" : "well-known";
      break;
    }
  }
  if (!probe.prm) {
    probe.prmSource = "none";
    return probe;
  }

  const servers = probe.prm.authorization_servers;
  const first = Array.isArray(servers) && typeof servers[0] === "string" ? servers[0] : undefined;
  if (!first) return probe;
  probe.authorizationServer = first;

  let asCandidates: string[];
  try {
    asCandidates = asMetadataCandidates(first);
  } catch {
    return probe;
  }
  for (const url of asCandidates) {
    const meta = await getJson(probe.exchanges, fetchImpl, url, timeoutMs);
    if (meta) {
      probe.asMetadata = meta;
      probe.asMetadataUrl = url;
      break;
    }
  }
  return probe;
}

function isLocal(url: URL): boolean {
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
}

export function checkAuth(probe: AuthProbe, profiles: Iterable<Profile>): Finding[] {
  const want = new Set(profiles);
  const findings: Finding[] = [];
  const add = (f: Finding) => {
    if (want.has(f.profile)) findings.push(f);
  };

  let url: URL | undefined;
  try {
    url = new URL(probe.serverUrl);
  } catch {
    add({ ruleId: "AUT009", severity: "error", profile: "core", message: "Server URL is not a valid URL.", evidence: probe.serverUrl, reference: REFS.mcpAuth });
    return findings;
  }
  if (url.protocol !== "https:" && !isLocal(url)) {
    add({
      ruleId: "AUT009", severity: "error", profile: "core",
      message: "Remote MCP servers must be served over HTTPS; authorization endpoints and tokens travel over this connection.",
      evidence: probe.serverUrl, reference: REFS.mcpAuth,
    });
  }

  for (const ex of probe.exchanges) {
    if (ex.error?.startsWith("timed out") || ex.ms > DISCOVERY_BUDGET_MS) {
      add({
        ruleId: "AUT008", severity: "error", profile: "claude",
        message: "A discovery request took longer than 10 s. Claude requires discovery, registration and token endpoints to answer within 10 s.",
        evidence: `${ex.method} ${ex.url}: ${ex.error ?? `${ex.ms} ms`}`, reference: REFS.claudeAuth,
      });
    }
  }

  if (probe.initializeStatus === undefined) {
    add({
      ruleId: "AUT100", severity: "warning", profile: "core",
      message: "No HTTP response to an unauthenticated initialize, so auth discovery could not be checked.",
      evidence: probe.initializeError, reference: REFS.mcpAuth,
    });
    return findings;
  }

  const status = probe.initializeStatus;
  if (status >= 200 && status < 300) {
    add({
      ruleId: "AUT000", severity: "info", profile: "core",
      message: "Accepted an unauthenticated initialize. Fine for public data; anything that touches a user's account needs OAuth.",
      evidence: `HTTP ${status}`, reference: REFS.mcpAuth,
    });
    return findings;
  }
  if (status === 404 || status === 405) {
    add({
      ruleId: "AUT011", severity: "warning", profile: "claude",
      message: "The URL did not accept a Streamable HTTP POST. If this is a legacy SSE endpoint, Claude's directory recommends Streamable HTTP.",
      evidence: `HTTP ${status}`, reference: REFS.claudeReview,
    });
    return findings;
  }
  if (status !== 401 && status !== 403) {
    add({
      ruleId: "AUT101", severity: "warning", profile: "core",
      message: "Unexpected status for an unauthenticated initialize; expected 401 (protected) or 200 (public).",
      evidence: `HTTP ${status}`, reference: REFS.mcpAuth,
    });
    return findings;
  }
  if (status === 403) {
    add({
      ruleId: "AUT012", severity: "warning", profile: "claude",
      message: "Unauthenticated requests got 403; clients start OAuth on 401.",
      evidence: "HTTP 403", reference: REFS.claudeAuth,
    });
  }
  if (!probe.resourceMetadataUrl) {
    add({
      ruleId: "AUT001", severity: "error", profile: "claude",
      message: "401 without resource_metadata in WWW-Authenticate. Claude expects the 401 to point at the protected resource metadata.",
      evidence: probe.wwwAuthenticate ? `WWW-Authenticate: ${probe.wwwAuthenticate}` : "no WWW-Authenticate header", reference: REFS.claudeAuth,
    });
  }
  if (!probe.prm) {
    add({
      ruleId: "AUT002", severity: "error", profile: "claude",
      message: "No protected resource metadata (RFC 9728) found, at the header URL or the well-known locations.",
      evidence: probe.exchanges.filter((e) => e.method === "GET").map((e) => `${e.url} -> ${e.status ?? e.error}`).join("; "),
      reference: REFS.rfc9728,
    });
    return findings;
  }

  const resource = probe.prm.resource;
  if (typeof resource !== "string") {
    add({
      ruleId: "AUT003", severity: "error", profile: "core",
      message: "Protected resource metadata has no `resource` field (required by RFC 9728).",
      evidence: probe.prmUrl, reference: REFS.rfc9728,
    });
  } else if (resource !== probe.serverUrl) {
    add({
      ruleId: "AUT003", severity: "error", profile: "claude",
      message: "`resource` in the protected resource metadata does not exactly equal the server URL. Claude requires an exact match.",
      evidence: `resource: ${resource} | server: ${probe.serverUrl}`, reference: REFS.claudeAuth,
    });
  }

  if (!probe.authorizationServer) {
    add({
      ruleId: "AUT002", severity: "error", profile: "claude",
      message: "Protected resource metadata lists no authorization_servers.",
      evidence: probe.prmUrl, reference: REFS.rfc9728,
    });
    return findings;
  }
  if (!probe.asMetadata) {
    add({
      ruleId: "AUT004", severity: "error", profile: "claude",
      message: "No authorization server metadata (RFC 8414 or OpenID discovery) for the first authorization server.",
      evidence: probe.authorizationServer, reference: REFS.rfc8414,
    });
    return findings;
  }

  const meta = probe.asMetadata;
  if (typeof meta.issuer === "string" && meta.issuer.replace(/\/+$/, "") !== probe.authorizationServer.replace(/\/+$/, "")) {
    add({
      ruleId: "AUT010", severity: "error", profile: "core",
      message: "Authorization server metadata `issuer` does not match the authorization server identifier. RFC 8414 clients must reject it.",
      evidence: `issuer: ${meta.issuer} | listed: ${probe.authorizationServer}`, reference: REFS.rfc8414,
    });
  }
  const pkce = meta.code_challenge_methods_supported;
  if (!Array.isArray(pkce) || !pkce.includes("S256")) {
    add({
      ruleId: "AUT005", severity: "error", profile: "claude",
      message: "Metadata does not advertise PKCE S256 in code_challenge_methods_supported. Claude requires S256, and MCP clients must refuse to proceed without it.",
      evidence: `code_challenge_methods_supported: ${JSON.stringify(pkce)}`, reference: REFS.mcpAuth,
    });
  }
  if (typeof meta.registration_endpoint !== "string" && meta.client_id_metadata_document_supported !== true) {
    add({
      ruleId: "AUT006", severity: "warning", profile: "claude",
      message: "Neither dynamic client registration (registration_endpoint) nor client ID metadata documents are advertised. Claude supports DCR or CIMD by default; anything else must be arranged with Anthropic.",
      reference: REFS.claudeAuth,
    });
  }
  const grants = meta.grant_types_supported;
  if (Array.isArray(grants)) {
    if (!grants.includes("authorization_code")) {
      add({
        ruleId: "AUT007", severity: "error", profile: "claude",
        message: "grant_types_supported lacks authorization_code; Claude connects users through the authorization code flow.",
        evidence: JSON.stringify(grants), reference: REFS.claudeAuth,
      });
    }
    if (!grants.includes("refresh_token")) {
      add({
        ruleId: "AUT007", severity: "warning", profile: "claude",
        message: "grant_types_supported lacks refresh_token, so users will be signed out whenever the access token expires.",
        evidence: JSON.stringify(grants), reference: REFS.claudeAuth,
      });
    }
  }
  return findings;
}
