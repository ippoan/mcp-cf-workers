import { describe, it, expect } from "vitest";
import { CfAccessClient, CfApiRequestError } from "../src/lib/cf-api";

function fakeFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init)) as unknown as typeof fetch;
}
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
const envelope = <T>(result: T) => ({ success: true, errors: [], messages: [], result });

describe("CfAccessClient write endpoints", () => {
  it("create_access_policy POSTs the body and unwraps result", async () => {
    let seen: { url: string; method?: string; body?: string } = { url: "" };
    const client = new CfAccessClient({
      accountId: "a",
      token: "t",
      baseUrl: "https://cf.test/v4",
      fetchImpl: fakeFetch((url, init) => {
        seen = { url, method: init?.method, body: init?.body as string };
        return jsonResponse(envelope({ id: "pol-1", name: "Allow" }));
      }),
    });
    const body = { name: "Allow", decision: "allow", include: [{ email: { email: "x@y.z" } }] };
    const res = await client.createAccessPolicy(body);
    expect(res).toEqual({ id: "pol-1", name: "Allow" });
    expect(seen.url).toBe("https://cf.test/v4/accounts/a/access/policies");
    expect(seen.method).toBe("POST");
    expect(JSON.parse(seen.body ?? "null")).toEqual(body);
  });

  it("create_access_app POSTs and returns uid/aud", async () => {
    let seenBody = "";
    const client = new CfAccessClient({
      accountId: "a",
      token: "t",
      baseUrl: "https://cf.test/v4",
      fetchImpl: fakeFetch((_url, init) => {
        seenBody = (init?.body as string) ?? "";
        return jsonResponse(envelope({ uid: "app-1", aud: "aud-xyz" }));
      }),
    });
    const res = await client.createAccessApp({
      name: "egov",
      type: "self_hosted",
      domain: "egov.test",
      policies: ["pol-1"],
      allowed_idps: [],
    });
    expect(res).toEqual({ uid: "app-1", aud: "aud-xyz" });
    expect(JSON.parse(seenBody).domain).toBe("egov.test");
  });

  it("update_access_app PUTs to the encoded uid path", async () => {
    let seen = { url: "", method: "" };
    const client = new CfAccessClient({
      accountId: "a",
      token: "t",
      baseUrl: "https://cf.test/v4",
      fetchImpl: fakeFetch((url, init) => {
        seen = { url, method: init?.method ?? "" };
        return jsonResponse(envelope({ uid: "app-1" }));
      }),
    });
    await client.updateAccessApp("app 1", { name: "renamed" });
    expect(seen.url).toBe("https://cf.test/v4/accounts/a/access/apps/app%201");
    expect(seen.method).toBe("PUT");
  });

  it("delete_* use DELETE with an encoded uid", async () => {
    const seen: { url: string; method?: string }[] = [];
    const client = new CfAccessClient({
      accountId: "a",
      token: "t",
      baseUrl: "https://cf.test/v4",
      fetchImpl: fakeFetch((url, init) => {
        seen.push({ url, method: init?.method });
        return jsonResponse(envelope({ id: "gone" }));
      }),
    });
    await client.deleteAccessApp("app-1");
    await client.deleteAccessPolicy("pol/2");
    expect(seen[0]).toEqual({
      url: "https://cf.test/v4/accounts/a/access/apps/app-1",
      method: "DELETE",
    });
    expect(seen[1]).toEqual({
      url: "https://cf.test/v4/accounts/a/access/policies/pol%2F2",
      method: "DELETE",
    });
  });

  it("write errors surface as CfApiRequestError without echoing the token", async () => {
    const client = new CfAccessClient({
      accountId: "a",
      token: "tok-secret",
      baseUrl: "https://cf.test/v4",
      fetchImpl: fakeFetch(() =>
        jsonResponse(
          { success: false, errors: [{ code: 10001, message: "forbidden" }], messages: [], result: null },
          403,
        ),
      ),
    });
    const err = await client
      .createAccessApp({ name: "x", type: "self_hosted", domain: "d" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(CfApiRequestError);
    expect(err.status).toBe(403);
    expect(String(err.message)).toContain("10001: forbidden");
    expect(String(err.message)).not.toContain("tok-secret");
  });

  it("GET reads send no request body", async () => {
    let hadBody = true;
    const client = new CfAccessClient({
      accountId: "a",
      token: "t",
      baseUrl: "https://cf.test/v4",
      fetchImpl: fakeFetch((_url, init) => {
        hadBody = init?.body !== undefined;
        return jsonResponse(envelope([]));
      }),
    });
    await client.listAccessApps();
    expect(hadBody).toBe(false);
  });
});
