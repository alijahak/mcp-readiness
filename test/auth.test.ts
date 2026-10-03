import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asMetadataCandidates, checkAuth, parseResourceMetadata, prmCandidates, probeAuth } from "../src/auth.js";
import type { AuthProbe, Profile } from "../src/types.js";

const ALL: Profile[] = ["claude", "chatgpt", "core"];

interface Config {
  initStatus: number;
  wwwAuthenticate?: (base: string) => string | undefined;
  sessionId?: string;
  prmAtHeaderPath: boolean;
  prmAtRoot: boolean;
  prm: (base: string) => Record<string, unknown>;
  asPath: "oauth" | "oidc" | "none";
  as: (base: string) => Record<string, unknown>;
  slowPrmMs: number;
}

const defaults = (): Config => ({
  initStatus: 401,
  wwwAuthenticate: (base) => `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
  prmAtHeaderPath: true,
  prmAtRoot: false,
  prm: (base) => ({ resource: `${base}/mcp`, authorization_servers: [base] }),
  asPath: "oauth",
  as: (base) => ({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code", "refresh_token"],
  }),
  slowPrmMs: 0,
});

let server: Server;
let base = "";
let config = defaults();
const seen: string[] = [];

function json(res: ServerResponse, body: unknown) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    seen.push(`${req.method} ${req.url}`);
    req.resume();
    const url = req.url ?? "/";
    if (url === "/mcp") {
      if (req.method === "DELETE") return void res.writeHead(200).end();
      const headers: Record<string, string> = { "content-type": "application/json" };
      const www = config.wwwAuthenticate?.(base);
      if (www && config.initStatus >= 400) headers["www-authenticate"] = www;
      if (config.sessionId) headers["mcp-session-id"] = config.sessionId;
      res.writeHead(config.initStatus, headers);
      return void res.end(config.initStatus === 200 ? JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }) : "");
    }
    if ((url === "/.well-known/oauth-protected-resource/mcp" && config.prmAtHeaderPath) || (url === "/.well-known/oauth-protected-resource" && config.prmAtRoot)) {
      if (config.slowPrmMs) return void setTimeout(() => json(res, config.prm(base)), config.slowPrmMs);
      return json(res, config.prm(base));
    }
    if (url === "/.well-known/oauth-authorization-server" && config.asPath === "oauth") return json(res, config.as(base));
    if (url === "/.well-known/openid-configuration" && config.asPath === "oidc") return json(res, config.as(base));
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  config = defaults();
  seen.length = 0;
});

async function findings(timeoutMs?: number) {
  const probe = await probeAuth(`${base}/mcp`, { timeoutMs });
  return { probe, ids: checkAuth(probe, ALL).map((f) => f.ruleId) };
}

describe("probeAuth + checkAuth against a local server", () => {
  it("a conforming server has no findings", async () => {
    const { probe, ids } = await findings();
    expect(ids).toEqual([]);
    expect(probe.prmSource).toBe("header");
    expect(probe.asMetadataUrl).toBe(`${base}/.well-known/oauth-authorization-server`);
  });

  it("AUT001: 401 without resource_metadata, PRM found only by well-known fallback", async () => {
    config.wwwAuthenticate = () => 'Bearer realm="mcp"';
    const { probe, ids } = await findings();
    expect(ids).toEqual(["AUT001"]);
    expect(probe.prmSource).toBe("well-known");
  });

  it("AUT012: 403 instead of 401", async () => {
    config.initStatus = 403;
    expect((await findings()).ids).toEqual(["AUT012"]);
  });

  it("AUT002: no protected resource metadata anywhere", async () => {
    config.wwwAuthenticate = undefined;
    config.prmAtHeaderPath = false;
    const { ids } = await findings();
    expect(ids).toEqual(["AUT001", "AUT002"]);
  });

  it("AUT003: resource does not exactly match the server URL", async () => {
    config.prm = (b) => ({ resource: `${b}/mcp/`, authorization_servers: [b] });
    expect((await findings()).ids).toEqual(["AUT003"]);
  });

  it("AUT004: authorization server metadata missing", async () => {
    config.asPath = "none";
    expect((await findings()).ids).toEqual(["AUT004"]);
  });

  it("finds metadata at the OpenID discovery location", async () => {
    config.asPath = "oidc";
    const { probe, ids } = await findings();
    expect(ids).toEqual([]);
    expect(probe.asMetadataUrl).toBe(`${base}/.well-known/openid-configuration`);
  });

  it("AUT005/AUT006/AUT007: no S256, no registration, no refresh", async () => {
    config.as = (b) => ({ issuer: b, code_challenge_methods_supported: ["plain"], grant_types_supported: ["authorization_code"] });
    expect((await findings()).ids).toEqual(["AUT005", "AUT006", "AUT007"]);
  });

  it("accepts CIMD instead of DCR", async () => {
    config.as = (b) => ({ issuer: b, code_challenge_methods_supported: ["S256"], client_id_metadata_document_supported: true });
    expect((await findings()).ids).toEqual([]);
  });

  it("AUT010: issuer mismatch", async () => {
    config.as = (b) => ({ ...defaults().as(b), issuer: "https://elsewhere.example" });
    expect((await findings()).ids).toEqual(["AUT010"]);
  });

  it("AUT000: public server, and the opened session is closed", async () => {
    config.initStatus = 200;
    config.sessionId = "abc";
    const { ids } = await findings();
    expect(ids).toEqual(["AUT000"]);
    expect(seen).toContain("DELETE /mcp");
  });

  it("AUT008: a slow discovery endpoint", async () => {
    config.slowPrmMs = 1_000;
    const { ids } = await findings(200);
    expect(ids).toContain("AUT008");
  });
});

describe("checkAuth on a constructed probe", () => {
  it("AUT009: plain HTTP to a non-local host", () => {
    const probe: AuthProbe = { serverUrl: "http://mcp.example.com/mcp", initializeStatus: 200, exchanges: [] };
    expect(checkAuth(probe, ALL).map((f) => f.ruleId)).toEqual(["AUT009", "AUT000"]);
  });

  it("AUT100: no response at all", () => {
    const probe: AuthProbe = { serverUrl: "https://mcp.example.com/mcp", initializeError: "ECONNREFUSED", exchanges: [] };
    expect(checkAuth(probe, ALL).map((f) => f.ruleId)).toEqual(["AUT100"]);
  });
});

describe("discovery helpers", () => {
  it("parses resource_metadata quoted and bare", () => {
    expect(parseResourceMetadata('Bearer error="invalid_token", resource_metadata="https://a.example/.well-known/oauth-protected-resource"'))
      .toBe("https://a.example/.well-known/oauth-protected-resource");
    expect(parseResourceMetadata("Bearer resource_metadata=https://a.example/prm")).toBe("https://a.example/prm");
    expect(parseResourceMetadata('Bearer realm="x"')).toBeUndefined();
    expect(parseResourceMetadata(undefined)).toBeUndefined();
  });

  it("builds RFC 9728 and RFC 8414 candidate URLs", () => {
    expect(prmCandidates("https://a.example/v1/mcp")).toEqual([
      "https://a.example/.well-known/oauth-protected-resource/v1/mcp",
      "https://a.example/.well-known/oauth-protected-resource",
    ]);
    expect(prmCandidates("https://a.example/")).toEqual(["https://a.example/.well-known/oauth-protected-resource"]);
    expect(asMetadataCandidates("https://auth.example/tenant1")).toEqual([
      "https://auth.example/.well-known/oauth-authorization-server/tenant1",
      "https://auth.example/.well-known/openid-configuration/tenant1",
      "https://auth.example/tenant1/.well-known/openid-configuration",
    ]);
    expect(asMetadataCandidates("https://auth.example")).toEqual([
      "https://auth.example/.well-known/oauth-authorization-server",
      "https://auth.example/.well-known/openid-configuration",
    ]);
  });
});
