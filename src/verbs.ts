/**
 * Infers what a tool probably does from its name (and, failing that, the first word of its description),
 * so declared annotations can be compared against it. This is a heuristic: it flags mismatches for a human
 * to confirm. It does not prove behaviour; only running the tool does.
 */

/** `exec` = runs caller-supplied code or queries; read-only only if the server enforces it. */
export type Effect = "read" | "write" | "destructive" | "send" | "exec" | "unknown";

// ChatGPT's guidelines count deletion, overwriting, cancellation and revocation as destructive...
const DESTRUCTIVE = [
  "delete", "remove", "drop", "purge", "destroy", "wipe", "truncate", "erase", "revoke", "cancel",
  "terminate", "kill", "uninstall", "unsubscribe", "overwrite", "reset", "clear", "discard", "deactivate",
];

// ...and irreversible sends and transactions.
const SEND = [
  "send", "publish", "pay", "submit", "broadcast", "notify", "buy", "sell",
  // also nouns, so they only count when they lead the name (see AMBIGUOUS)
  "post", "email", "message", "tweet", "dm", "reply", "invite", "order", "purchase", "transfer", "charge", "refund",
];

const WRITE = [
  "create", "add", "insert", "update", "edit", "modify", "patch", "put", "set", "write", "save",
  "archive", "unarchive", "move", "rename", "copy", "close", "reopen", "assign", "unassign", "approve",
  "reject", "grant", "start", "stop", "restart", "rollback", "install", "enable", "disable", "subscribe",
  "follow", "unfollow", "like", "unstar", "replace", "upsert", "register", "unregister", "unlock", "unblock",
  "mute", "unmute", "unpin", "toggle", "increment", "decrement", "attach", "detach", "unlink", "unshare",
  "reorder", "fill", "click", "upload",
  // also nouns
  "comment", "label", "star", "schedule", "share", "rate", "block", "lock", "pin", "commit", "merge",
  "deploy", "import", "sign", "scale", "vote", "link", "tag", "react", "mark", "book", "fork", "complete",
  "navigate", "press", "drag", "apply", "configure", "provision", "migrate", "rotate", "type", "select",
  "push",
];

const EXEC = ["execute", "exec", "run", "invoke", "eval", "evaluate", "call"];

const READ = [
  "get", "list", "search", "find", "fetch", "read", "query", "describe", "show", "lookup", "look",
  "view", "inspect", "retrieve", "browse", "count", "preview", "discover", "locate", "explore", "peek",
  "summarize", "explain", "validate", "check", "compare", "grep", "ls", "cat",
  // also nouns
  "status", "info", "stat", "head", "tail", "download", "export", "diff", "screenshot", "snapshot",
];

/** Words that are commonly nouns in tool names (`list_orders`, `get_comments`); they only count as the leading token. */
const AMBIGUOUS = new Set([
  "post", "email", "message", "tweet", "dm", "reply", "invite", "order", "purchase", "transfer", "charge",
  "refund", "comment", "label", "star", "schedule", "share", "rate", "block", "lock", "pin", "commit",
  "merge", "deploy", "import", "sign", "scale", "vote", "link", "tag", "react", "mark", "book", "fork",
  "complete", "navigate", "press", "drag", "apply", "configure", "provision", "migrate", "rotate", "type",
  "select", "status", "info", "stat", "head", "tail", "download", "export", "diff", "screenshot", "snapshot",
  "upload", "push",
]);

const CONNECTORS = new Set(["or", "and", "then"]);

const LEXICON = new Map<string, Effect>();
for (const [words, effect] of [
  [READ, "read"], [WRITE, "write"], [EXEC, "exec"], [SEND, "send"], [DESTRUCTIVE, "destructive"],
] as const) {
  for (const w of words) LEXICON.set(w, effect);
}

/** Splits `createIssue`, `create_issue`, `create-issue`, `issues.create` into lowercase tokens. */
export function tokenize(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

/** Very small stemmer for third-person and plural forms: "creates" -> "create", "searches" -> "search". */
export function stem(word: string): string {
  const w = word.toLowerCase();
  if (LEXICON.has(w)) return w;
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (/(ches|shes|sses|xes|zes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) return w.slice(0, -1);
  return w;
}

export function classifyVerb(word: string): Effect {
  return LEXICON.get(stem(word)) ?? "unknown";
}

export interface InferredEffect {
  effect: Effect;
  /** The word the inference rests on, for evidence. */
  verb?: string;
  source?: "name" | "description";
}

const RANK: Record<Effect, number> = { destructive: 5, send: 4, write: 3, exec: 2, read: 1, unknown: 0 };

/**
 * Name first: the first unambiguous verb among the first four tokens decides (`list_orders` is a read,
 * `github_create_issue` a write). A connector (`get_or_create`, `search_and_replace`) makes the strongest
 * verb decide. A noun-like verb (`post`, `order`) only counts when it leads the name. Then the first word
 * of the description ("Creates a ..."). Otherwise unknown.
 */
export function inferEffect(name: string, description?: string): InferredEffect {
  const fromName = inferFromTokens(tokenize(name).slice(0, 4));
  if (fromName.effect !== "unknown") return { ...fromName, source: "name" };

  if (description) {
    const first = description.trim().split(/\s+/)[0]?.replace(/[^A-Za-z]/g, "");
    if (first) {
      const effect = classifyVerb(first);
      if (effect !== "unknown") return { effect, verb: first.toLowerCase(), source: "description" };
    }
  }
  return { effect: "unknown" };
}

function inferFromTokens(tokens: string[]): InferredEffect {
  const verbs = tokens
    .map((t, i) => ({ t, i, effect: classifyVerb(t), ambiguous: AMBIGUOUS.has(stem(t)) }))
    .filter((v) => v.effect !== "unknown");
  if (verbs.length === 0) return { effect: "unknown" };

  if (tokens.some((t) => CONNECTORS.has(t))) {
    const strongest = verbs.reduce((a, b) => (RANK[b.effect] > RANK[a.effect] ? b : a));
    return { effect: strongest.effect, verb: strongest.t };
  }

  const firstClear = verbs.find((v) => !v.ambiguous);
  if (firstClear) return { effect: firstClear.effect, verb: firstClear.t };

  const leading = verbs.find((v) => v.i === 0);
  if (leading) return { effect: leading.effect, verb: leading.t };
  return { effect: "unknown" };
}
