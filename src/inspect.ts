import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { VERSION } from "./version.js";
import type { Inspection, RawTool } from "./types.js";

/** Accepts whatever the server sends so that non-conforming tool definitions are reported, not rejected. */
const LooseToolsPage = z.looseObject({
  tools: z.array(z.unknown()),
  nextCursor: z.string().optional(),
});

const MAX_PAGES = 50;

export interface StdioTarget {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface HttpTarget {
  url: string;
  headers?: Record<string, string>;
}

export interface InspectOptions {
  timeoutMs?: number;
}

function newClient(): Client {
  return new Client({ name: "mcp-readiness", version: VERSION }, { capabilities: {} });
}

/** Lists every tool, following pagination. Reads only; never calls a tool. */
async function listAllTools(client: Client, timeoutMs: number): Promise<RawTool[]> {
  const tools: RawTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await client.request(
      { method: "tools/list", params: cursor ? { cursor } : {} },
      LooseToolsPage,
      { timeout: timeoutMs },
    );
    for (const t of result.tools) tools.push((typeof t === "object" && t !== null ? t : { name: undefined, value: t }) as RawTool);
    cursor = result.nextCursor;
    if (!cursor) return tools;
  }
  throw new Error(`tools/list still paginating after ${MAX_PAGES} pages`);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function closeQuietly(client: Client): Promise<void> {
  try {
    await client.close();
  } catch {
    // Closing a transport that never opened can throw; there is nothing left to clean up then.
  }
}

async function collect(client: Client, transport: Transport, inspection: Inspection, timeoutMs: number): Promise<void> {
  await client.connect(transport, { timeout: timeoutMs });
  await afterConnect(client, inspection, timeoutMs);
}

async function afterConnect(client: Client, inspection: Inspection, timeoutMs: number): Promise<void> {
  const info = client.getServerVersion();
  inspection.server = info ? { name: info.name, version: info.version, title: (info as { title?: string }).title } : undefined;
  if (!client.getServerCapabilities()?.tools) {
    inspection.errors.push("Server does not declare the tools capability.");
  }
  inspection.tools = await listAllTools(client, timeoutMs);
}

export async function inspectStdio(target: StdioTarget, opts: InspectOptions = {}): Promise<Inspection> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const inspection: Inspection = {
    target: { kind: "stdio", command: target.command, args: target.args ?? [] },
    tools: [],
    errors: [],
  };
  const transport = new StdioClientTransport({
    command: target.command,
    args: target.args ?? [],
    env: { ...getDefaultEnvironment(), ...(target.env ?? {}) },
    cwd: target.cwd,
    stderr: "pipe",
  });
  let stderrTail = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2000);
  });

  const client = newClient();
  try {
    await collect(client, transport, inspection, timeoutMs);
  } catch (err) {
    inspection.errors.push(`Could not inspect the server: ${errorText(err)}`);
    if (stderrTail.trim()) inspection.errors.push(`Server stderr (tail): ${stderrTail.trim()}`);
  } finally {
    await closeQuietly(client);
  }
  return inspection;
}

function isUnauthorized(err: unknown): boolean {
  const text = errorText(err);
  return /\b401\b|unauthori[sz]ed/i.test(text) || (err as { code?: number }).code === 401;
}

export async function inspectHttp(target: HttpTarget, opts: InspectOptions = {}): Promise<Inspection> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const inspection: Inspection = { target: { kind: "http", url: target.url }, tools: [], errors: [] };
  const url = new URL(target.url);
  const requestInit: RequestInit = { headers: target.headers ?? {} };

  const streamable = newClient();
  let connected = false;
  try {
    await streamable.connect(new StreamableHTTPClientTransport(url, { requestInit }), { timeout: timeoutMs });
    connected = true;
    await afterConnect(streamable, inspection, timeoutMs);
    return inspection;
  } catch (err) {
    if (isUnauthorized(err)) {
      inspection.toolsUnavailable = "The server requires authorization (HTTP 401). Pass --header \"Authorization: Bearer <token>\" to check its tools.";
      return inspection;
    }
    if (connected) {
      // The transport works; the failure is the server's, so a transport fallback would only hide it.
      inspection.errors.push(`Connected, but listing tools failed: ${errorText(err)}`);
      return inspection;
    }
    inspection.errors.push(`Streamable HTTP failed: ${errorText(err)}`);
  } finally {
    await closeQuietly(streamable);
  }

  // Legacy HTTP+SSE servers (protocol 2024-11-05) still exist; try once before giving up.
  const sse = newClient();
  try {
    await collect(sse, new SSEClientTransport(url, { requestInit }), inspection, timeoutMs);
    inspection.errors.push("Connected only over the legacy HTTP+SSE transport; Claude's directory recommends Streamable HTTP.");
  } catch (err) {
    if (isUnauthorized(err)) {
      inspection.toolsUnavailable = "The server requires authorization (HTTP 401). Pass --header \"Authorization: Bearer <token>\" to check its tools.";
    } else {
      inspection.errors.push(`Legacy SSE failed: ${errorText(err)}`);
    }
  } finally {
    await closeQuietly(sse);
  }
  return inspection;
}

/** Runs against an already-connected transport (used by tests and by anyone embedding the checker). */
export async function inspectTransport(transport: Transport, label: string, opts: InspectOptions = {}): Promise<Inspection> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const inspection: Inspection = { target: { kind: "stdio", command: label, args: [] }, tools: [], errors: [] };
  const client = newClient();
  try {
    await collect(client, transport, inspection, timeoutMs);
  } catch (err) {
    inspection.errors.push(`Could not inspect the server: ${errorText(err)}`);
  } finally {
    await closeQuietly(client);
  }
  return inspection;
}
