/**
 * MCP tool registry (single source of truth)。
 *
 * `server.ts` がこの list をループして `createWorkerMcp` の McpServer に登録する。
 * tool を追加する時は `src/mcp/tools.ts` に 1 つ書いて、この list に push するだけ。
 *
 * `requiresScope` は scope gating 用。read tool (PR1) は省略 = binding_jwt が
 * valid なら誰でも呼べる。write tool (PR2) は `"mcp.write"` を立て、server.ts が
 * binding_jwt の scope と突合して 403 相当を返す (secrets-inventory 方式)。
 */
import type { z } from "zod";
import type { CfAccessClient } from "../lib/cf-api";

export interface ToolEntry<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  /** zod object schema。`.shape` を McpServer.registerTool に渡し、SDK が validate する。 */
  inputSchema: S;
  /** 必要 scope。省略 = read (認証済みなら誰でも)。write は "mcp.write"。 */
  requiresScope?: string;
  /** tool 本体。client は token 注入済みの CF REST client。 */
  execute: (client: CfAccessClient, args: z.infer<S>) => Promise<unknown>;
}
