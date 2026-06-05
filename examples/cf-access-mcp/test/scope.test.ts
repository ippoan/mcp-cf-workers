import { describe, it, expect } from "vitest";
import { z } from "zod";
import { parseScopes, isToolAllowed } from "../src/mcp/scope";
import type { ToolEntry } from "../src/mcp/registry";

const readTool = {
  name: "r",
  description: "",
  inputSchema: z.object({}),
  execute: async () => ({}),
} as unknown as ToolEntry<z.ZodTypeAny>;

const writeTool = {
  name: "w",
  description: "",
  inputSchema: z.object({}),
  requiresScope: "mcp.write",
  execute: async () => ({}),
} as unknown as ToolEntry<z.ZodTypeAny>;

describe("parseScopes", () => {
  it("splits a space-separated scope string", () => {
    expect(parseScopes("mcp.read mcp.write")).toEqual(new Set(["mcp.read", "mcp.write"]));
  });

  it("collapses extra whitespace and handles empty / undefined", () => {
    expect(parseScopes("  mcp.read   mcp.write ")).toEqual(new Set(["mcp.read", "mcp.write"]));
    expect(parseScopes("")).toEqual(new Set());
    expect(parseScopes(undefined)).toEqual(new Set());
  });
});

describe("isToolAllowed", () => {
  it("read tool (no requiresScope) is always allowed", () => {
    expect(isToolAllowed(readTool, new Set())).toBe(true);
    expect(isToolAllowed(readTool, parseScopes("mcp.read"))).toBe(true);
  });

  it("write tool needs the matching scope", () => {
    expect(isToolAllowed(writeTool, new Set())).toBe(false);
    expect(isToolAllowed(writeTool, parseScopes("mcp.read"))).toBe(false);
    expect(isToolAllowed(writeTool, parseScopes("mcp.read mcp.write"))).toBe(true);
  });
});
