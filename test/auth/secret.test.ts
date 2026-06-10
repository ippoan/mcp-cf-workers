import { describe, it, expect } from "vitest";
import { resolveSecret } from "../../src/auth/secret";

describe("resolveSecret", () => {
  it("returns a plain string as-is", async () => {
    expect(await resolveSecret("abc")).toBe("abc");
  });

  it("returns null for undefined / null / empty string", async () => {
    expect(await resolveSecret(undefined)).toBeNull();
    expect(await resolveSecret(null)).toBeNull();
    expect(await resolveSecret("")).toBeNull();
  });

  it("resolves a SecretsStoreSecret-shaped binding via .get()", async () => {
    const binding = { get: async () => "from-store" };
    expect(await resolveSecret(binding)).toBe("from-store");
  });

  it("returns null when .get() resolves to empty string", async () => {
    const binding = { get: async () => "" };
    expect(await resolveSecret(binding)).toBeNull();
  });

  it("returns null when .get() throws (fail-closed)", async () => {
    const binding = {
      get: async () => {
        throw new Error("store unavailable");
      },
    };
    expect(await resolveSecret(binding)).toBeNull();
  });
});
