import { describe, it, expect } from "vitest";
import {
  timingSafeEqual,
  constantTimeEqualBytes,
  b64urlToBytes,
  b64urlToString,
  bytesToB64url,
  stringToB64url,
} from "../../src/auth/crypto";

describe("timingSafeEqual", () => {
  it("returns true for equal strings", async () => {
    expect(await timingSafeEqual("hunter2", "hunter2")).toBe(true);
  });

  it("returns false for differing equal-length strings", async () => {
    expect(await timingSafeEqual("hunter2", "hunterX")).toBe(false);
  });

  it("returns false for differing-length strings (length hidden via HMAC)", async () => {
    expect(await timingSafeEqual("short", "a-much-longer-token-value")).toBe(false);
  });

  it("returns true for two empty strings", async () => {
    expect(await timingSafeEqual("", "")).toBe(true);
  });

  it("returns false comparing empty vs non-empty", async () => {
    expect(await timingSafeEqual("", "x")).toBe(false);
  });

  it("handles unicode", async () => {
    expect(await timingSafeEqual("トークン🔑", "トークン🔑")).toBe(true);
    expect(await timingSafeEqual("トークン🔑", "トークン🔒")).toBe(false);
  });
});

describe("constantTimeEqualBytes", () => {
  it("true for identical byte arrays", () => {
    expect(constantTimeEqualBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
  });
  it("false for differing same-length arrays", () => {
    expect(constantTimeEqualBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
  });
  it("false for differing-length arrays", () => {
    expect(constantTimeEqualBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
  it("true for two empty arrays", () => {
    expect(constantTimeEqualBytes(new Uint8Array([]), new Uint8Array([]))).toBe(true);
  });
});

describe("base64url roundtrip", () => {
  it("string → b64url → string", () => {
    for (const s of ["", "hello", "日本語テスト", '{"a":1,"b":"x"}', "+/=padding?"]) {
      expect(b64urlToString(stringToB64url(s))).toBe(s);
    }
  });

  it("bytes → b64url → bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(Array.from(b64urlToBytes(bytesToB64url(bytes)))).toEqual(Array.from(bytes));
  });

  it("emits url-safe alphabet without padding", () => {
    // 0xFB 0xFF encodes to "+/" in standard base64 → "-_" url-safe.
    const enc = bytesToB64url(new Uint8Array([0xfb, 0xff]));
    expect(enc).not.toMatch(/[+/=]/);
  });

  it("decodes input that is missing padding", () => {
    // "Zm9v" = "foo"; strip nothing, but exercise the no-pad branch with "Zg" = "f".
    expect(b64urlToString("Zg")).toBe("f");
    expect(b64urlToString("Zm8")).toBe("fo");
    expect(b64urlToString("Zm9v")).toBe("foo");
  });
});
