import { describe, it, expect } from "vitest";
import {
  listAccessAppsTool,
  getAccessAppTool,
  listAccessPoliciesTool,
  listServiceTokensTool,
  listIdentityProvidersTool,
  listAccessGroupsTool,
  listAuditLogsTool,
  READ_TOOLS,
} from "../src/mcp/tools";
import type { CfAccessClient } from "../src/lib/cf-api";

/** 呼ばれた client メソッドと引数を記録する fake。各 method は固定値を返す。 */
function fakeClient(calls: string[]): CfAccessClient {
  const rec =
    (name: string, ret: unknown) =>
    async (...args: unknown[]) => {
      calls.push(`${name}(${args.join(",")})`);
      return ret;
    };
  return {
    listAccessApps: rec("listAccessApps", [{ uid: "a" }]),
    getAccessApp: rec("getAccessApp", { uid: "a" }),
    listAccessPolicies: rec("listAccessPolicies", [{ id: "p" }]),
    listServiceTokens: rec("listServiceTokens", [{ id: "s" }]),
    listIdentityProviders: rec("listIdentityProviders", [{ id: "i" }]),
    listAccessGroups: rec("listAccessGroups", [{ id: "g" }]),
    listAuditLogs: rec("listAuditLogs", [{ id: "log1" }]),
  } as unknown as CfAccessClient;
}

describe("read tools delegate to the CF client", () => {
  it("list_access_apps → client.listAccessApps", async () => {
    const calls: string[] = [];
    const res = await listAccessAppsTool.execute(fakeClient(calls), {});
    expect(res).toEqual([{ uid: "a" }]);
    expect(calls).toEqual(["listAccessApps()"]);
  });

  it("get_access_app → client.getAccessApp(uid)", async () => {
    const calls: string[] = [];
    const res = await getAccessAppTool.execute(fakeClient(calls), { uid: "app-123" });
    expect(res).toEqual({ uid: "a" });
    expect(calls).toEqual(["getAccessApp(app-123)"]);
  });

  it("list_access_policies → client.listAccessPolicies", async () => {
    const calls: string[] = [];
    await listAccessPoliciesTool.execute(fakeClient(calls), {});
    expect(calls).toEqual(["listAccessPolicies()"]);
  });

  it("list_service_tokens → client.listServiceTokens", async () => {
    const calls: string[] = [];
    await listServiceTokensTool.execute(fakeClient(calls), {});
    expect(calls).toEqual(["listServiceTokens()"]);
  });

  it("list_identity_providers → client.listIdentityProviders", async () => {
    const calls: string[] = [];
    await listIdentityProvidersTool.execute(fakeClient(calls), {});
    expect(calls).toEqual(["listIdentityProviders()"]);
  });

  it("list_access_groups → client.listAccessGroups", async () => {
    const calls: string[] = [];
    await listAccessGroupsTool.execute(fakeClient(calls), {});
    expect(calls).toEqual(["listAccessGroups()"]);
  });

  it("list_audit_logs → client.listAuditLogs, returns the raw result", async () => {
    const calls: string[] = [];
    const res = await listAuditLogsTool.execute(fakeClient(calls), {});
    expect(res).toEqual([{ id: "log1" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^listAuditLogs\(/);
  });

  it("list_audit_logs maps snake_case args to the client's camelCase filter", async () => {
    let seenFilter: unknown;
    const client = {
      listAuditLogs: async (filter: unknown) => {
        seenFilter = filter;
        return [];
      },
    } as unknown as CfAccessClient;
    await listAuditLogsTool.execute(client, {
      since: "2026-07-01T00:00:00Z",
      before: "2026-07-04T00:00:00Z",
      actor_email: "m.tama.ramu@gmail.com",
      resource_product: "workers",
      limit: 50,
      cursor: "abc123",
    });
    expect(seenFilter).toEqual({
      since: "2026-07-01T00:00:00Z",
      before: "2026-07-04T00:00:00Z",
      actorEmail: "m.tama.ramu@gmail.com",
      resourceProduct: "workers",
      limit: 50,
      cursor: "abc123",
    });
  });
});

describe("READ_TOOLS registry", () => {
  it("exposes the 7 read tools with unique names in a stable order", () => {
    const names = READ_TOOLS.map((t) => t.name);
    expect(names).toEqual([
      "list_access_apps",
      "get_access_app",
      "list_access_policies",
      "list_service_tokens",
      "list_identity_providers",
      "list_access_groups",
      "list_audit_logs",
    ]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("read tools carry no requiresScope (gated only by binding_jwt validity)", () => {
    for (const t of READ_TOOLS) {
      expect(t.requiresScope).toBeUndefined();
      expect(t.description.length).toBeGreaterThan(0);
    }
  });
});

describe("input schemas", () => {
  it("get_access_app requires a non-empty uid and rejects extras", () => {
    expect(getAccessAppTool.inputSchema.safeParse({}).success).toBe(false);
    expect(getAccessAppTool.inputSchema.safeParse({ uid: "" }).success).toBe(false);
    expect(getAccessAppTool.inputSchema.safeParse({ uid: "x" }).success).toBe(true);
    expect(getAccessAppTool.inputSchema.safeParse({ uid: "x", extra: 1 }).success).toBe(false);
  });

  it("no-arg tools reject unknown keys (strict)", () => {
    expect(listAccessAppsTool.inputSchema.safeParse({}).success).toBe(true);
    expect(listAccessAppsTool.inputSchema.safeParse({ extra: 1 }).success).toBe(false);
  });

  it("list_audit_logs args are all optional but reject unknown keys / bad types", () => {
    expect(listAuditLogsTool.inputSchema.safeParse({}).success).toBe(true);
    expect(
      listAuditLogsTool.inputSchema.safeParse({
        since: "2026-07-01T00:00:00Z",
        actor_email: "m.tama.ramu@gmail.com",
        limit: 50,
      }).success,
    ).toBe(true);
    expect(listAuditLogsTool.inputSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(listAuditLogsTool.inputSchema.safeParse({ cursor: "" }).success).toBe(true);
    expect(listAuditLogsTool.inputSchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});
