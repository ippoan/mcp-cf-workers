import { describe, it, expect } from "vitest";
import {
  createAccessPolicyTool,
  deleteAccessPolicyTool,
  createAccessAppTool,
  updateAccessAppTool,
  deleteAccessAppTool,
  protectHostnameTool,
  buildInclude,
  WRITE_TOOLS,
  ALL_TOOLS,
} from "../src/mcp/tools";
import type { CfAccessClient } from "../src/lib/cf-api";

type Call = { m: string; args: unknown[] };

/** 呼び出しを記録する fake client。createAccessPolicy/App の戻り値は override 可能。 */
function fakeClient(calls: Call[], overrides: { policy?: unknown; app?: unknown } = {}): CfAccessClient {
  const rec =
    (m: string, ret: unknown) =>
    async (...args: unknown[]) => {
      calls.push({ m, args });
      return ret;
    };
  return {
    createAccessPolicy: rec("createAccessPolicy", overrides.policy ?? { id: "pol-1" }),
    deleteAccessPolicy: rec("deleteAccessPolicy", { id: "gone" }),
    createAccessApp: rec("createAccessApp", overrides.app ?? { uid: "app-1", aud: "aud-xyz" }),
    updateAccessApp: rec("updateAccessApp", { uid: "app-1" }),
    deleteAccessApp: rec("deleteAccessApp", { id: "gone" }),
  } as unknown as CfAccessClient;
}

describe("buildInclude", () => {
  it("maps everyone / emails / email_domains to CF include[]", () => {
    expect(buildInclude({ everyone: true })).toEqual([{ everyone: {} }]);
    expect(buildInclude({ emails: ["a@x.z", "b@x.z"] })).toEqual([
      { email: { email: "a@x.z" } },
      { email: { email: "b@x.z" } },
    ]);
    expect(buildInclude({ email_domains: ["ippoan.org"] })).toEqual([
      { email_domain: { domain: "ippoan.org" } },
    ]);
    expect(buildInclude({})).toEqual([]);
  });

  it("combines multiple allow kinds (everyone first)", () => {
    expect(buildInclude({ everyone: true, emails: ["a@x.z"] })).toEqual([
      { everyone: {} },
      { email: { email: "a@x.z" } },
    ]);
  });
});

describe("write tools delegate to the client", () => {
  it("create_access_policy builds include and forwards", async () => {
    const calls: Call[] = [];
    await createAccessPolicyTool.execute(fakeClient(calls), {
      name: "Allow",
      decision: "allow",
      allow: { emails: ["x@y.z"] },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.m).toBe("createAccessPolicy");
    expect(calls[0]!.args[0]).toEqual({
      name: "Allow",
      decision: "allow",
      include: [{ email: { email: "x@y.z" } }],
    });
  });

  it("create_access_policy rejects empty allow before any API call", async () => {
    const calls: Call[] = [];
    await expect(
      createAccessPolicyTool.execute(fakeClient(calls), { name: "x", decision: "allow", allow: {} }),
    ).rejects.toThrow(/at least one/);
    expect(calls).toHaveLength(0);
  });

  it("delete_access_policy / delete_access_app pass the uid", async () => {
    const calls: Call[] = [];
    const c = fakeClient(calls);
    await deleteAccessPolicyTool.execute(c, { uid: "pol-1" });
    await deleteAccessAppTool.execute(c, { uid: "app-1" });
    expect(calls.map((x) => [x.m, x.args[0]])).toEqual([
      ["deleteAccessPolicy", "pol-1"],
      ["deleteAccessApp", "app-1"],
    ]);
  });

  it("create_access_app forwards all fields", async () => {
    const calls: Call[] = [];
    await createAccessAppTool.execute(fakeClient(calls), {
      name: "egov",
      domain: "egov.test",
      type: "self_hosted",
      policies: ["pol-1"],
      allowed_idps: [],
    });
    expect(calls[0]!.args[0]).toEqual({
      name: "egov",
      type: "self_hosted",
      domain: "egov.test",
      policies: ["pol-1"],
      allowed_idps: [],
    });
  });

  it("update_access_app passes uid + patch", async () => {
    const calls: Call[] = [];
    await updateAccessAppTool.execute(fakeClient(calls), { uid: "app-1", patch: { name: "renamed" } });
    expect(calls[0]!.args).toEqual(["app-1", { name: "renamed" }]);
  });
});

describe("protect_hostname (composite)", () => {
  it("creates a policy then a self_hosted app and returns app_uid/aud/policy_id", async () => {
    const calls: Call[] = [];
    const client = fakeClient(calls, { policy: { id: "pol-9" }, app: { uid: "app-9", aud: "aud-9" } });
    const res = await protectHostnameTool.execute(client, {
      hostname: "egov-staging.ippoan.org",
      allow: { emails: ["m.tama.ramu@gmail.com"] },
    });
    expect(calls.map((x) => x.m)).toEqual(["createAccessPolicy", "createAccessApp"]);
    expect(calls[0]!.args[0]).toMatchObject({
      name: "protect egov-staging.ippoan.org",
      decision: "allow",
      include: [{ email: { email: "m.tama.ramu@gmail.com" } }],
    });
    expect(calls[1]!.args[0]).toMatchObject({
      type: "self_hosted",
      domain: "egov-staging.ippoan.org",
      policies: ["pol-9"],
      allowed_idps: [],
    });
    expect(res).toEqual({
      app_uid: "app-9",
      aud: "aud-9",
      policy_id: "pol-9",
      domain: "egov-staging.ippoan.org",
    });
  });

  it("rejects empty allow before any API call", async () => {
    const calls: Call[] = [];
    await expect(
      protectHostnameTool.execute(fakeClient(calls), { hostname: "x.test", allow: {} }),
    ).rejects.toThrow(/at least one/);
    expect(calls).toHaveLength(0);
  });

  it("throws if policy creation returns no id and does NOT create the app", async () => {
    const calls: Call[] = [];
    const client = fakeClient(calls, { policy: { name: "no-id" } });
    await expect(
      protectHostnameTool.execute(client, { hostname: "x.test", allow: { everyone: true } }),
    ).rejects.toThrow(/did not return an id/);
    expect(calls.map((x) => x.m)).toEqual(["createAccessPolicy"]);
  });
});

describe("WRITE_TOOLS / ALL_TOOLS registry", () => {
  it("every write tool requires mcp.write", () => {
    expect(WRITE_TOOLS.map((t) => t.name)).toEqual([
      "create_access_policy",
      "delete_access_policy",
      "create_access_app",
      "update_access_app",
      "delete_access_app",
      "protect_hostname",
    ]);
    for (const t of WRITE_TOOLS) expect(t.requiresScope).toBe("mcp.write");
  });

  it("ALL_TOOLS = 7 read + 6 write with unique names", () => {
    expect(ALL_TOOLS).toHaveLength(13);
    const names = ALL_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(13);
    expect(names).toContain("protect_hostname");
    expect(names).toContain("list_audit_logs");
  });
});
