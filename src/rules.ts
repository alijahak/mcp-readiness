import {
  classifyVerb, inferDescriptionEffect, inferEffect, inferNameEffect, NO_WRITE_CLAIM, tokenize, type Effect,
} from "./verbs.js";
import type { Finding, Profile, RawTool, Severity, ToolRow } from "./types.js";

export const REFS = {
  claudeReview: "https://claude.com/docs/connectors/building/review-criteria",
  claudeAuth: "https://claude.com/docs/connectors/building/authentication",
  claudePolicy: "https://support.claude.com/en/articles/13145358",
  chatgptSubmission: "https://developers.openai.com/apps-sdk/app-submission-guidelines",
  mcpTools: "https://modelcontextprotocol.io/specification/2025-11-25/server/tools",
  mcpAuth: "https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization",
  rfc9728: "https://www.rfc-editor.org/rfc/rfc9728",
  rfc8414: "https://www.rfc-editor.org/rfc/rfc8414",
} as const;

const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;
type HintName = (typeof HINTS)[number];

const METHOD_KEYS = new Set(["method", "httpmethod", "verb", "action", "operation", "op", "command", "cmd"]);
const HTTP_METHOD_EFFECT: Record<string, Effect> = {
  get: "read", head: "read", options: "read", post: "write", put: "write", patch: "write", delete: "destructive",
};
const PATH_KEYS = new Set(["path", "url", "endpoint", "route", "uri"]);

/** Property names that ask the model for something ChatGPT forbids: credentials, API keys, card data, government IDs. */
const RESTRICTED_SUFFIXES = [
  "password", "passwd", "passphrase", "apikey", "secret", "accesstoken", "refreshtoken", "authtoken",
  "bearertoken", "privatekey", "cardnumber", "creditcard", "cvv", "cvc", "ssn", "socialsecuritynumber",
  "passportnumber", "driverslicense", "driverslicensenumber", "nationalid", "taxid",
];

const DIRECTIVES: Array<[RegExp, string]> = [
  [/\b(ignore|disregard|forget)\b[^.]{0,40}\b(previous|prior|above|earlier|other|system)\b/i, "tells the model to ignore other instructions"],
  [/\b(always|first)\s+(call|use|run|invoke)\s+this\s+tool\b/i, "tells the model to prefer this tool"],
  [/\bbefore\s+(using|calling|running)\s+any\s+other\s+tool/i, "tells the model to call this tool before others"],
  [/\binstead\s+of\s+(the\s+)?(other|any)\s+tools?\b/i, "steers the model away from other tools"],
  [/\b(do\s+not|don't|never)\s+(tell|mention|reveal|inform|show)\b[^.]{0,30}\b(user|human)\b/i, "instructs the model what to tell the user"],
  [/<\s*\/?\s*(important|system|instructions?|secret)\s*>/i, "contains an instruction tag"],
];

/** Text that tells the model to act without asking the user first. */
const SKIP_CONFIRMATION =
  /(\b(do\s+not|don't|never)\s+(re-?ask|ask\s+(again|for\s+confirmation|the\s+user\s+to\s+confirm)|confirm|double[- ]check|wait\s+for\s+confirmation)\b|\bno\s+confirmation\s+(step|needed|required)\b|\bwithout\s+(asking|confirming|confirmation)\b)/i;

// Narrow on purpose: "returns the best match" and a trading signal of "Buy now" are not advertising.
const PROMOTION = /(#1\b|\bnumber one\b|\bworld'?s (best|leading|first)\b|\brevolutionary\b|\bsponsored\b|\bsign up (now|today)\b|\blimited[- ]time offer\b|\bvisit our (website|site)\b|\buse (promo )?code\b)/i;

// Zero-width space, word joiners and invisible operators, BOM, bidi embedding/override/isolate controls
// ("Trojan Source"), Unicode tag characters (U+E0000-U+E007F), and HTML comments. ZWJ/ZWNJ and LRM/RLM are
// left out on purpose: emoji sequences and Persian, Arabic, Hebrew and Indic text use them legitimately.
const HIDDEN_CHARS = /[\u200B\u2060-\u2064\uFEFF\u202A-\u202E\u2066-\u2069]/g;
const HIDDEN = /[\u200B\u2060-\u2064\uFEFF\u202A-\u202E\u2066-\u2069]|\uDB40[\uDC00-\uDC7F]|<!--/;

const SPEC_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

interface Ctx {
  profiles: Set<Profile>;
  findings: Finding[];
}

function add(ctx: Ctx, f: Finding): void {
  if (ctx.profiles.has(f.profile)) ctx.findings.push(f);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function clip(s: string, n = 120): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
}

function visible(s: string): string {
  return s
    .replace(HIDDEN_CHARS, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)
    .replace(/\uDB40[\uDC00-\uDC7F]/g, (pair) => `\\u{${pair.codePointAt(0)?.toString(16)}}`);
}

export function checkTools(tools: RawTool[], profiles: Iterable<Profile>): { findings: Finding[]; rows: ToolRow[] } {
  const ctx: Ctx = { profiles: new Set(profiles), findings: [] };
  const rows: ToolRow[] = [];
  const seen = new Map<string, number>();

  tools.forEach((tool, index) => {
    const before = ctx.findings.length;
    const name = typeof tool.name === "string" ? tool.name : "";
    const label = name || `#${index}`;
    seen.set(name, (seen.get(name) ?? 0) + 1);

    const annotations = isObject(tool.annotations) ? tool.annotations : undefined;
    const title = str(tool.title) ?? str(annotations?.title);
    const description = typeof tool.description === "string" ? tool.description : undefined;
    const hints: Partial<Record<HintName, boolean>> = {};
    for (const h of HINTS) {
      const v = annotations?.[h];
      if (typeof v === "boolean") hints[h] = v;
      else if (v !== undefined) {
        add(ctx, {
          ruleId: "ANN004", severity: "error", profile: "core", tool: label,
          message: `${h} must be a boolean; clients ignore or misread other types.`,
          evidence: `${h}: ${JSON.stringify(v)}`, reference: REFS.mcpTools,
        });
      }
    }
    const inferred = inferEffect(name, description);
    const evidence: Evidence = {
      effect: inferred.effect,
      verb: inferred.verb,
      nameEffect: inferNameEffect(name).effect,
      descriptionEffect: inferDescriptionEffect(description).effect,
      claimsNoWrite: description !== undefined && NO_WRITE_CLAIM.test(description),
    };

    checkNaming(ctx, name, label);
    checkAnnotations(ctx, label, title, hints, evidence);
    // Read-only tools run without confirmation anyway, so "without asking" text only matters elsewhere.
    const readsOnly = hints.readOnlyHint === true || evidence.effect === "read";
    checkDescriptions(ctx, tool, label, description, readsOnly);
    checkSchema(ctx, tool, label);

    rows.push({
      name: label,
      title,
      ...hints,
      inferredEffect: inferred.effect,
      findings: [...new Set(ctx.findings.slice(before).map((f) => f.ruleId))],
    });
  });

  for (const [name, count] of seen) {
    if (count > 1 && name) {
      add(ctx, {
        ruleId: "NAM003", severity: "error", profile: "core", tool: name,
        message: `Tool name is used ${count} times; clients key tools by name, so all but one are unreachable.`,
        evidence: name, reference: REFS.mcpTools,
      });
    }
  }
  return { findings: ctx.findings, rows };
}

function checkNaming(ctx: Ctx, name: string, label: string): void {
  if (!name) {
    add(ctx, {
      ruleId: "NAM000", severity: "error", profile: "core", tool: label,
      message: "Tool has no name.", reference: REFS.mcpTools,
    });
    return;
  }
  if (name.length > 64) {
    add(ctx, {
      ruleId: "NAM001", severity: "error", profile: "claude", tool: label,
      message: `Tool name is ${name.length} characters; Claude's directory allows at most 64.`,
      evidence: name, reference: REFS.claudeReview,
    });
  }
  if (!SPEC_NAME.test(name)) {
    add(ctx, {
      ruleId: "NAM002", severity: "warning", profile: "core", tool: label,
      message: "Tool names should be 1-128 characters of A-Z, a-z, 0-9, underscore, hyphen or dot.",
      evidence: visible(name), reference: REFS.mcpTools,
    });
  }
}

/** What the name and description say a tool does, kept separate so a mismatch can be weighed. */
interface Evidence {
  effect: Effect;
  verb?: string;
  nameEffect: Effect;
  descriptionEffect: Effect;
  /** The description says outright that the tool changes nothing ("writes nothing", "read-only"). */
  claimsNoWrite: boolean;
}

const CHANGES = new Set<Effect>(["write", "send", "destructive"]);

function checkAnnotations(
  ctx: Ctx,
  label: string,
  title: string | undefined,
  hints: Partial<Record<HintName, boolean>>,
  ev: Evidence,
): void {
  const { effect, verb } = ev;
  if (!title) {
    add(ctx, {
      ruleId: "ANN001", severity: "error", profile: "claude", tool: label,
      message: "No title (neither `title` nor `annotations.title`). Claude's review requires a title on every tool.",
      reference: REFS.claudeReview,
    });
  }
  if (hints.readOnlyHint === undefined && hints.destructiveHint === undefined) {
    add(ctx, {
      ruleId: "ANN002", severity: "error", profile: "claude", tool: label,
      message: "Neither readOnlyHint nor destructiveHint is set. Claude's review requires the applicable one on every tool, and it decides whether the user is asked to confirm each call.",
      reference: REFS.claudeReview,
    });
  } else if (hints.readOnlyHint !== true && hints.destructiveHint === undefined && (effect === "write" || effect === "send" || effect === "destructive")) {
    add(ctx, {
      ruleId: "ANN005", severity: "warning", profile: "claude", tool: label,
      message: "Write tool without an explicit destructiveHint. The default is true, so say so on purpose, or set false if the change is additive.",
      evidence: verb ? `verb: ${verb}` : undefined, reference: REFS.claudeReview,
    });
  }

  const missing = (["readOnlyHint", "destructiveHint", "openWorldHint"] as const).filter((h) => hints[h] === undefined);
  if (missing.length > 0) {
    add(ctx, {
      ruleId: "ANN003", severity: "error", profile: "chatgpt", tool: label,
      message: `ChatGPT's submission guidelines require explicit booleans for readOnlyHint, destructiveHint and openWorldHint. Missing: ${missing.join(", ")}.`,
      reference: REFS.chatgptSubmission,
    });
  }

  if (hints.readOnlyHint === true && !ev.claimsNoWrite) {
    if (CHANGES.has(effect)) {
      // An error needs two independent signals: the name and the description both describe a change.
      // One signal alone ("start_assessment" that only returns a URL) is a question for a human.
      const corroborated = CHANGES.has(ev.nameEffect) && CHANGES.has(ev.descriptionEffect);
      const what = effect === "write" ? "changes data" : effect === "send" ? "sends or transacts" : "deletes or cancels";
      add(ctx, {
        ruleId: "ANN010", severity: corroborated ? "error" : "warning", profile: "core", tool: label,
        message: corroborated
          ? `Marked readOnlyHint: true, but both the name and the description say it ${what}. Claude can run read-only tools without asking the user.`
          : `Marked readOnlyHint: true, but the ${ev.nameEffect !== "unknown" ? "name" : "description"} suggests it ${what}. Confirm it really changes nothing.`,
        evidence: `verb: ${verb}`, reference: REFS.claudeReview,
      });
    } else if (effect === "exec") {
      add(ctx, {
        ruleId: "ANN010", severity: "warning", profile: "core", tool: label,
        message: "Marked readOnlyHint: true on a tool that runs caller-supplied code or queries. Only correct if the server enforces read-only (for example, a read-only transaction or role).",
        evidence: `verb: ${verb}`, reference: REFS.claudeReview,
      });
    }
  }
  if (hints.readOnlyHint === true && hints.destructiveHint === true) {
    add(ctx, {
      ruleId: "ANN013", severity: "warning", profile: "core", tool: label,
      message: "readOnlyHint: true together with destructiveHint: true is contradictory. destructiveHint only applies when readOnlyHint is false.",
      reference: REFS.mcpTools,
    });
  }

  // The description gets a veto: "send_case_mail" that only drafts a message ("Write a CaseMail message ...
  // and return a link the user opens to send it") is not a send.
  const contradicted = (e: Effect) => ev.descriptionEffect !== "unknown" && ev.descriptionEffect !== e;

  if (effect === "destructive" && hints.destructiveHint === false && !contradicted("destructive") && !ev.claimsNoWrite) {
    add(ctx, {
      ruleId: "ANN011", severity: "warning", profile: "core", tool: label,
      message: "The name says it deletes, cancels or overwrites, but destructiveHint is false, so clients may skip the confirmation.",
      evidence: `verb: ${verb}`, reference: REFS.chatgptSubmission,
    });
  }
  if (effect === "send" && hints.destructiveHint === false && !contradicted("send") && !ev.claimsNoWrite) {
    add(ctx, {
      ruleId: "ANN015", severity: "warning", profile: "chatgpt", tool: label,
      message: "ChatGPT's guidelines count irreversible sends and transactions as destructive, but destructiveHint is false.",
      evidence: `verb: ${verb}`, reference: REFS.chatgptSubmission,
    });
  }
  if (effect === "read" && hints.readOnlyHint !== true) {
    add(ctx, {
      ruleId: "ANN012", severity: "info", profile: "core", tool: label,
      message: "Looks like a read, but readOnlyHint is not true, so Claude will ask the user to confirm every call.",
      evidence: `verb: ${verb}`, reference: REFS.claudeReview,
    });
  }
}

function checkDescriptions(ctx: Ctx, tool: RawTool, label: string, description: string | undefined, readsOnly: boolean): void {
  if (!description || description.trim().length < 20) {
    add(ctx, {
      ruleId: "DSC001", severity: "warning", profile: "core", tool: label,
      message: "Missing or very short description. The model picks tools from their descriptions.",
      evidence: description ? clip(description) : undefined, reference: REFS.mcpTools,
    });
  }

  const texts: Array<[string, string]> = [];
  if (typeof tool.name === "string") texts.push(["name", tool.name]);
  if (typeof tool.title === "string") texts.push(["title", tool.title]);
  if (description) texts.push(["description", description]);
  for (const [prop, d] of propertyDescriptions(tool.inputSchema)) texts.push([`inputSchema.${prop}`, d]);

  for (const [where, text] of texts) {
    if (HIDDEN.test(text)) {
      add(ctx, {
        ruleId: "DSC003", severity: "error", profile: "core", tool: label,
        message: `Hidden text in ${where}: invisible Unicode characters or an HTML comment. Reviewers treat this as tool poisoning.`,
        evidence: clip(visible(text)), reference: REFS.claudeReview,
      });
    }
    if (where === "name") continue;
    const skip = readsOnly ? null : SKIP_CONFIRMATION.exec(text);
    if (skip) {
      add(ctx, {
        ruleId: "DSC005", severity: "warning", profile: "core", tool: label,
        message: `Text in ${where} tells the model to act without asking the user. Clients rely on the model and the hints to get consent, so check that this tool's hints still make the client confirm.`,
        evidence: clip(skip[0]), reference: REFS.claudeReview,
      });
    }
    for (const [re, why] of DIRECTIVES) {
      const m = re.exec(text);
      if (m) {
        add(ctx, {
          ruleId: "DSC002", severity: "warning", profile: "claude", tool: label,
          message: `Directive in ${where}: ${why}. Claude's review rejects descriptions that instruct the model.`,
          evidence: clip(m[0]), reference: REFS.claudeReview,
        });
        break;
      }
    }
    const promo = PROMOTION.exec(text);
    if (promo) {
      add(ctx, {
        ruleId: "DSC004", severity: "warning", profile: "claude", tool: label,
        message: `Promotional language in ${where}. Descriptions should say what the tool does, not sell it.`,
        evidence: clip(promo[0]), reference: REFS.claudeReview,
      });
    }
  }
}

/** True when a property schema can hold free text (string-typed, or untyped). Enums of fixed values can't carry a secret. */
function acceptsText(prop: unknown): boolean {
  if (!isObject(prop)) return true;
  if (Array.isArray(prop.enum)) return false;
  const t = prop.type;
  if (t === undefined) return true;
  return t === "string" || (Array.isArray(t) && t.includes("string"));
}

function propertyDescriptions(schema: unknown): Array<[string, string]> {
  if (!isObject(schema) || !isObject(schema.properties)) return [];
  const out: Array<[string, string]> = [];
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (isObject(prop) && typeof prop.description === "string") out.push([key, prop.description]);
  }
  return out;
}

function checkSchema(ctx: Ctx, tool: RawTool, label: string): void {
  const schema = tool.inputSchema;
  if (!isObject(schema) || schema.type !== "object") {
    add(ctx, {
      ruleId: "SCH001", severity: "error", profile: "core", tool: label,
      message: 'inputSchema must be a JSON Schema object with "type": "object".',
      evidence: clip(JSON.stringify(schema) ?? "undefined"), reference: REFS.mcpTools,
    });
    return;
  }
  const props = isObject(schema.properties) ? schema.properties : {};
  const entries = Object.entries(props);

  const undocumented = entries.filter(([, p]) => !isObject(p) || typeof p.description !== "string" || p.description.trim() === "");
  if (undocumented.length > 0) {
    add(ctx, {
      ruleId: "SCH002", severity: "info", profile: "core", tool: label,
      message: `${undocumented.length} of ${entries.length} input parameters have no description.`,
      evidence: undocumented.map(([k]) => k).slice(0, 8).join(", "), reference: REFS.mcpTools,
    });
  }

  for (const [key, prop] of entries) {
    const norm = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    const hit = RESTRICTED_SUFFIXES.find((s) => norm === s || norm.endsWith(s));
    // `require_secret: boolean` is a setting, not a secret: only free-text values can carry the data.
    if (hit && acceptsText(prop)) {
      add(ctx, {
        ruleId: "SCH003", severity: "error", profile: "chatgpt", tool: label,
        message: "Parameter name suggests it asks for restricted data. ChatGPT apps must never request credentials, API keys, payment card data or government IDs; use OAuth or server-side configuration instead.",
        evidence: `parameter: ${key}`, reference: REFS.chatgptSubmission,
      });
    }
  }

  checkCatchAll(ctx, label, props);
}

/** Claude rejects catch-all tools that take a method/operation argument and route to many endpoints. */
function checkCatchAll(ctx: Ctx, label: string, props: Record<string, unknown>): void {
  const keys = Object.keys(props);
  for (const key of keys) {
    const norm = key.toLowerCase().replace(/[^a-z]/g, "");
    if (!METHOD_KEYS.has(norm)) continue;
    const prop = props[key];
    const values = isObject(prop) && Array.isArray(prop.enum) ? prop.enum.filter((v): v is string => typeof v === "string") : [];
    if (values.length > 0) {
      const effects = new Set(values.map((v) => HTTP_METHOD_EFFECT[v.toLowerCase()] ?? classifyVerb(tokenize(v)[0] ?? v)));
      const reads = effects.has("read");
      const writes = effects.has("write") || effects.has("destructive") || effects.has("send");
      if (reads && writes) {
        add(ctx, {
          ruleId: "SPL001", severity: "error", profile: "claude", tool: label,
          message: `One tool does both reads and writes, selected by "${key}". Claude's review requires read and write actions in separate tools, and rejects catch-all method tools.`,
          evidence: `${key}: ${values.slice(0, 8).join(" | ")}`, reference: REFS.claudeReview,
        });
      }
    } else if (["method", "httpmethod", "verb"].includes(norm) && keys.some((k) => PATH_KEYS.has(k.toLowerCase()))) {
      add(ctx, {
        ruleId: "SPL001", severity: "warning", profile: "claude", tool: label,
        message: `Free-form "${key}" plus a path/URL argument: a generic API passthrough. Claude's review rejects catch-all method tools; expose specific tools instead.`,
        evidence: `${key} + ${keys.filter((k) => PATH_KEYS.has(k.toLowerCase())).join(", ")}`, reference: REFS.claudeReview,
      });
    }
  }
}

export function severityAtLeast(s: Severity, threshold: Severity): boolean {
  const order: Severity[] = ["error", "warning", "info"];
  return order.indexOf(s) <= order.indexOf(threshold);
}
