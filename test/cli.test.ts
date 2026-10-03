import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import type { Report } from "../src/types.js";

const fixture = fileURLToPath(new URL("./fixtures/stdio-fixture.mjs", import.meta.url));

describe("end to end over stdio", () => {
  it("finds every planted defect, and nothing on the clean tool", async () => {
    const { exitCode, output } = await run(["--format", "json", "--", process.execPath, fixture]);
    expect(exitCode).toBe(1);
    const report = JSON.parse(output) as Report;
    expect(report.server?.name).toBe("fixture");
    expect(report.toolCount).toBe(8);

    const byTool = (name: string) => report.findings.filter((f) => f.tool === name).map((f) => f.ruleId).sort();
    expect(byTool("get_forecast")).toEqual([]);
    expect(byTool("create_ticket")).toEqual(["ANN010"]);
    expect(byTool("delete_ticket")).toEqual(expect.arrayContaining(["ANN001", "ANN002", "ANN003"]));
    expect(byTool("purge_cache")).toContain("ANN011");
    expect(byTool("api_request")).toContain("SPL001");
    expect(byTool("connect_account")).toContain("SCH003");
    expect(byTool("search_docs")).toEqual(expect.arrayContaining(["DSC002", "DSC003"]));
    expect(byTool("list_all_open_support_tickets_assigned_to_the_current_user_by_priority")).toContain("NAM001");

    const row = report.toolTable.find((r) => r.name === "create_ticket");
    expect(row).toMatchObject({ readOnlyHint: true, inferredEffect: "write", findings: ["ANN010"] });
  }, 30_000);

  it("renders text and markdown, and --fail-on never exits 0", async () => {
    const text = await run(["--fail-on", "never", "--", process.execPath, fixture]);
    expect(text.exitCode).toBe(0);
    expect(text.output).toContain("Claude Connectors Directory");
    expect(text.output).toContain("not ready");
    expect(text.output).toContain("no tool was called");

    const md = await run(["--format", "markdown", "--profile", "chatgpt", "--", process.execPath, fixture]);
    expect(md.output).toContain("| ChatGPT app directory | not ready");
    expect(md.output).not.toContain("Claude Connectors Directory");
  }, 30_000);

  it("exits 2 when the server cannot start", async () => {
    const { exitCode, output } = await run(["--timeout", "5000", "--", process.execPath, "-e", "process.exit(3)"]);
    expect(exitCode).toBe(2);
    expect(output).toContain("Could not inspect the server");
  }, 30_000);
});

describe("argument handling", () => {
  it("requires a target", async () => {
    expect((await run([])).exitCode).toBe(2);
  });

  it("rejects both targets at once", async () => {
    expect((await run(["--url", "https://a.example/mcp", "--", "node"])).exitCode).toBe(2);
  });

  it("rejects unknown profiles and formats", async () => {
    expect((await run(["--profile", "copilot", "--", "node"])).output).toContain("Unknown profile");
    expect((await run(["--format", "xml", "--", "node"])).output).toContain("Unknown format");
  });

  it("prints help and version", async () => {
    expect((await run(["--help"])).output).toContain("Usage:");
    expect((await run(["--version"])).output).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
