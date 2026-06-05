import { describe, it, expect } from "vitest";
import { CfAccessClient, CfApiRequestError } from "../src/lib/cf-api";

/** handler(url, init) を fetch 互換にする薄い fake。 */
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

describe("CfAccessClient", () => {
  it("lists access apps, unwraps result, sends Bearer token", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const client = new CfAccessClient({
      accountId: "acct1",
      token: "tok-secret",
      baseUrl: "https://cf.test/client/v4",
      fetchImpl: fakeFetch((url, init) => {
        seenUrl = url;
        seenAuth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
        return jsonResponse(envelope([{ uid: "a1", name: "egov" }]));
      }),
    });

    const apps = await client.listAccessApps();
    expect(apps).toEqual([{ uid: "a1", name: "egov" }]);
    expect(seenUrl).toBe("https://cf.test/client/v4/accounts/acct1/access/apps");
    expect(seenAuth).toBe("Bearer tok-secret");
  });

  it("defaults to the official CF base URL", async () => {
    let seenUrl = "";
    const client = new CfAccessClient({
      accountId: "acct",
      token: "t",
      fetchImpl: fakeFetch((url) => {
        seenUrl = url;
        return jsonResponse(envelope([]));
      }),
    });
    await client.listAccessApps();
    expect(seenUrl).toBe("https://api.cloudflare.com/client/v4/accounts/acct/access/apps");
  });

  it("percent-encodes the uid in get_access_app", async () => {
    let seenUrl = "";
    const client = new CfAccessClient({
      accountId: "acct1",
      token: "t",
      baseUrl: "https://cf.test/v4",
      fetchImpl: fakeFetch((url) => {
        seenUrl = url;
        return jsonResponse(envelope({ uid: "x" }));
      }),
    });
    await client.getAccessApp("a/b uid");
    expect(seenUrl).toBe("https://cf.test/v4/accounts/acct1/access/apps/a%2Fb%20uid");
  });

  it("hits the expected paths for every read endpoint", async () => {
    const seen: string[] = [];
    const client = new CfAccessClient({
      accountId: "a",
      token: "t",
      baseUrl: "https://cf.test/v4",
      fetchImpl: fakeFetch((url) => {
        seen.push(url.replace("https://cf.test/v4/accounts/a", ""));
        return jsonResponse(envelope([]));
      }),
    });
    await client.listAccessPolicies();
    await client.listServiceTokens();
    await client.listIdentityProviders();
    await client.listAccessGroups();
    expect(seen).toEqual([
      "/access/policies",
      "/access/service_tokens",
      "/access/identity_providers",
      "/access/groups",
    ]);
  });

  it("throws CfApiRequestError (with code: message) on success:false", async () => {
    const client = new CfAccessClient({
      accountId: "a",
      token: "tok-secret",
      fetchImpl: fakeFetch(() =>
        jsonResponse({ success: false, errors: [{ code: 1001, message: "bad request" }], messages: [], result: null }),
      ),
    });
    const err = await client.listAccessPolicies().catch((e) => e);
    expect(err).toBeInstanceOf(CfApiRequestError);
    expect(err.status).toBe(200);
    expect(err.errors).toEqual([{ code: 1001, message: "bad request" }]);
    expect(String(err.message)).toContain("1001: bad request");
    // 値漏れ防止: token を message に echo しない
    expect(String(err.message)).not.toContain("tok-secret");
  });

  it("throws on non-2xx HTTP", async () => {
    const client = new CfAccessClient({
      accountId: "a",
      token: "t",
      fetchImpl: fakeFetch(() =>
        jsonResponse({ success: false, errors: [], messages: [], result: null }, 403),
      ),
    });
    await expect(client.listServiceTokens()).rejects.toMatchObject({ status: 403 });
  });

  it("throws on non-JSON body", async () => {
    const client = new CfAccessClient({
      accountId: "a",
      token: "t",
      fetchImpl: fakeFetch(() => new Response("<html>oops</html>", { status: 502 })),
    });
    await expect(client.listIdentityProviders()).rejects.toMatchObject({ status: 502 });
  });

  it("wraps fetch rejection as status 0", async () => {
    const client = new CfAccessClient({
      accountId: "a",
      token: "t",
      fetchImpl: fakeFetch(() => {
        throw new Error("network down");
      }),
    });
    const err = await client.listAccessGroups().catch((e) => e);
    expect(err).toBeInstanceOf(CfApiRequestError);
    expect(err.status).toBe(0);
    expect(String(err.message)).toContain("network down");
  });
});
