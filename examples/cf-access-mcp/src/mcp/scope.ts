/**
 * MCP tool の scope gating ロジック (pure)。
 *
 * server.ts (SDK 配線、coverage exclude) から切り出し、node で直接テストできる
 * ようにする。binding_jwt middleware が返す `scope` (空白区切り) と
 * `tool.requiresScope` を突合する。
 */
import type { z } from "zod";
import type { ToolEntry } from "./registry";

/** OAuth 慣例の空白区切り scope を Set に。未提供は空 Set (= write tool 不可)。 */
export function parseScopes(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(raw.split(/\s+/).filter((s) => s.length > 0));
}

/**
 * tool が要求する scope を caller が持つか。`requiresScope` 無しの read tool は
 * 常に許可 (binding_jwt が valid な時点で read は通す)。write tool は
 * `requiresScope` (例 `"mcp.write"`) を caller の scope が含む時のみ許可。
 */
export function isToolAllowed(tool: ToolEntry<z.ZodTypeAny>, scopes: Set<string>): boolean {
  return !tool.requiresScope || scopes.has(tool.requiresScope);
}
