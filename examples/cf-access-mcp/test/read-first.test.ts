import { describe, expect, it } from "vitest";
import { readFirstTool, ALL_TOOLS, READ_TOOLS } from "../src/mcp/tools";

const NAME = "MUST_READ_FIRST_or_other_tools_will_fail";

type Result = {
  intro: string;
  tools: Array<{ name: string; description: string; requires_scope?: string }>;
  workflows: Record<string, string>;
  pitfalls: string[];
};

// execute は client を受け取らない (= CF REST を叩けない) 形で定義されている。
const run = async () => (await readFirstTool.execute()) as Result;

describe("MUST_READ_FIRST tool metadata", () => {
  it("has the same name as secrets-inventory and is listed in READ_TOOLS", () => {
    expect(readFirstTool.name).toBe(NAME);
    expect(READ_TOOLS.map((t) => t.name)).toContain(NAME);
    expect(ALL_TOOLS.map((t) => t.name)).toContain(NAME);
  });

  it("description starts with MUST READ FIRST and warns about skipping", () => {
    expect(readFirstTool.description).toMatch(/^MUST READ FIRST/);
    expect(readFirstTool.description).toMatch(/(fail|error|Skipping)/i);
  });

  it("requires no scope and takes no args", () => {
    expect((readFirstTool as { requiresScope?: string }).requiresScope).toBeUndefined();
    expect(readFirstTool.inputSchema.safeParse({}).success).toBe(true);
    expect(readFirstTool.inputSchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});

describe("MUST_READ_FIRST execute()", () => {
  it("returns intro / tools / workflows / pitfalls", async () => {
    const r = await run();
    expect(r.intro).toContain("Cloudflare Zero Trust");
    expect(r.intro).toContain("mcp.write");
    expect(r.tools.length).toBeGreaterThan(0);
    expect(Object.keys(r.workflows).length).toBeGreaterThan(0);
    expect(r.pitfalls.length).toBeGreaterThan(0);
  });

  it("does not include itself in the tools list", async () => {
    const r = await run();
    expect(r.tools.map((t) => t.name)).not.toContain(NAME);
  });

  it("lists every other tool in ALL_TOOLS (no drift), with scope only when required", async () => {
    const r = await run();
    const others = ALL_TOOLS.filter((t) => t.name !== NAME);
    expect(r.tools).toHaveLength(others.length);
    others.forEach((t, i) => {
      expect(r.tools[i]!.name).toBe(t.name);
      expect(r.tools[i]!.description).toBe(t.description);
      expect(r.tools[i]!.requires_scope).toBe(t.requiresScope);
    });
    expect(r.tools.find((t) => t.name === "update_access_app")?.requires_scope).toBe("mcp.write");
    expect(r.tools.find((t) => t.name === "list_access_apps")?.requires_scope).toBeUndefined();
  });

  it("workflows explain the service-token policy via update_access_app patch.policies", async () => {
    const w = (await run()).workflows;
    const svc = w.add_service_token_policy!;
    expect(svc).toContain("create_service_token");
    expect(svc).toContain("update_access_app");
    expect(svc).toContain("policies");
    expect(svc).toContain("non_identity");
    expect(svc).toContain("service_token");
    expect(svc).toContain("list_access_policies");
    expect(w.protect_hostname_by_email).toContain("protect_hostname");
    expect(w.workers_dev_hostname).toContain("workers.dev");
  });

  it("warns that update_access_app is a full replace and to get_access_app first", async () => {
    const r = await run();
    expect(r.workflows.update_access_app_is_full_replace).toMatch(/full replace/);
    expect(r.workflows.update_access_app_is_full_replace).toContain("get_access_app");
    expect(r.pitfalls.join("\n")).toMatch(/full replace/);
  });

  it("pitfalls: inline policy before asking for dashboard work", async () => {
    const p = (await run()).pitfalls.join("\n");
    expect(p).toContain("create_access_policy");
    expect(p).toContain("service_token");
    expect(p).toContain("ダッシュボード");
  });

  it("contains no real-environment identifiers (account id / emails)", async () => {
    const s = JSON.stringify(await run());
    expect(s).not.toMatch(/[0-9a-f]{32}/);
    expect(s).not.toMatch(/[\w.+-]+@(?!example)[\w-]+\.[a-z]+/i);
  });
});
