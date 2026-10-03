/** Which directory's rules a finding comes from. `core` = MCP spec and general hygiene. */
export type Profile = "claude" | "chatgpt" | "core";

export const ALL_PROFILES: readonly Profile[] = ["claude", "chatgpt", "core"];

/** `error` = likely rejection or a real safety problem; `warning` = probably wrong; `info` = worth a look. */
export type Severity = "error" | "warning" | "info";

export const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

export interface Finding {
  ruleId: string;
  severity: Severity;
  profile: Profile;
  /** Tool the finding is about, if any. */
  tool?: string;
  message: string;
  /** Short, concrete evidence (the field value, header, or URL that triggered the rule). */
  evidence?: string;
  /** Where the requirement is published. */
  reference: string;
}

/** A tool exactly as the server returned it from `tools/list`. Deliberately loose: non-conforming servers are what we are here to catch. */
export interface RawTool {
  name?: unknown;
  title?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
  [key: string]: unknown;
}

export interface ServerInfo {
  name?: string;
  version?: string;
  title?: string;
  protocolVersion?: string;
}

export interface HttpExchange {
  url: string;
  method: string;
  status?: number;
  ms: number;
  error?: string;
}

export interface AuthProbe {
  serverUrl: string;
  /** Status of an unauthenticated `initialize` POST. */
  initializeStatus?: number;
  initializeError?: string;
  wwwAuthenticate?: string;
  resourceMetadataUrl?: string;
  /** How the protected resource metadata was found: the WWW-Authenticate header, a well-known fallback, or not at all. */
  prmSource?: "header" | "well-known" | "none";
  prm?: Record<string, unknown>;
  prmUrl?: string;
  authorizationServer?: string;
  asMetadataUrl?: string;
  asMetadata?: Record<string, unknown>;
  exchanges: HttpExchange[];
}

export interface Inspection {
  target: { kind: "stdio"; command: string; args: string[] } | { kind: "http"; url: string };
  server?: ServerInfo;
  tools: RawTool[];
  /** True when tools/list could not be read (for example, the server requires a token we do not have). */
  toolsUnavailable?: string;
  auth?: AuthProbe;
  errors: string[];
}

export interface Report {
  tool: { name: "mcp-readiness"; version: string };
  checkedAt: string;
  target: Inspection["target"];
  server?: ServerInfo;
  profiles: Profile[];
  toolCount: number;
  toolsUnavailable?: string;
  findings: Finding[];
  summary: Record<Profile, Record<Severity, number>>;
  /** Annotation truth table: one row per tool. */
  toolTable: ToolRow[];
  auth?: AuthProbe;
  errors: string[];
}

export interface ToolRow {
  name: string;
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  inferredEffect: "read" | "write" | "destructive" | "send" | "exec" | "unknown";
  findings: string[];
}
