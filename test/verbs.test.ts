import { describe, expect, it } from "vitest";
import { inferEffect, stem, tokenize } from "../src/verbs.js";

describe("tokenize", () => {
  it("splits snake, kebab, camel, Pascal and dotted names", () => {
    expect(tokenize("create_issue")).toEqual(["create", "issue"]);
    expect(tokenize("create-issue")).toEqual(["create", "issue"]);
    expect(tokenize("createIssue")).toEqual(["create", "issue"]);
    expect(tokenize("HTTPGetRequest")).toEqual(["http", "get", "request"]);
    expect(tokenize("issues.create")).toEqual(["issues", "create"]);
  });
});

describe("stem", () => {
  it("handles third-person and plural forms", () => {
    expect(stem("creates")).toBe("create");
    expect(stem("searches")).toBe("search");
    expect(stem("queries")).toBe("query");
    expect(stem("status")).toBe("status");
  });
});

describe("inferEffect", () => {
  const effect = (name: string, description?: string) => inferEffect(name, description).effect;

  it("reads the verb from the name", () => {
    expect(effect("get_issue")).toBe("read");
    expect(effect("github_create_issue")).toBe("write");
    expect(effect("delete_branch")).toBe("destructive");
    expect(effect("send_email")).toBe("send");
    expect(effect("execute_sql")).toBe("exec");
  });

  it("does not mistake nouns for verbs", () => {
    expect(effect("list_orders")).toBe("read");
    expect(effect("get_comments")).toBe("read");
    expect(effect("search_messages")).toBe("read");
    expect(effect("get_document_type")).toBe("read");
    expect(effect("order_create")).toBe("write");
    expect(effect("browser_type")).toBe("unknown");
  });

  it("lets a leading noun-verb count", () => {
    expect(effect("post_message")).toBe("send");
    expect(effect("merge_pull_request")).toBe("write");
  });

  it("takes the strongest verb across a connector", () => {
    expect(effect("get_or_create_user")).toBe("write");
    expect(effect("search_and_replace")).toBe("write");
    expect(effect("archive_or_delete")).toBe("destructive");
  });

  it("regressions from the 2026-10 registry scan", () => {
    expect(effect("check_label_and_packaging")).toBe("read"); // "label" is a noun here
    expect(effect("polymarket_fill_risk")).toBe("unknown"); // "fill" is a trading noun
    expect(effect("guide_paracha", "Charge le guide de la paracha de la semaine.")).toBe("unknown"); // French
    expect(effect("calculate", "Evaluates a math expression.")).toBe("unknown"); // computation, not code execution
  });

  it("falls back to the first word of the description", () => {
    expect(effect("tickets", "Deletes a ticket.")).toBe("destructive");
    expect(effect("tickets", "Lists tickets.")).toBe("read");
    expect(effect("tickets", "Use this tool for tickets.")).toBe("unknown");
  });
});
