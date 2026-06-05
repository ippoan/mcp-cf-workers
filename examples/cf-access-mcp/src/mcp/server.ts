/**
 * MCP transport 配線。
 *
 * @ippoan/mcp-cf-workers の `createWorkerMcp` (stateless streamable HTTP) に
 * registry の tool を登録するだけの薄い 1 枚。実ロジックは `./tools` (pure) と
 * `../lib/cf-api` (CF REST client) に置き、ここはそれを MCP tool として公開する
 * アダプタに徹する (SDK / transport 依存はこのファイルに閉じる)。
 *
 * scope gating: request ごとに `createWorkerMcp` を呼び、binding_jwt middleware が
 * 立てた claims の scope を closure に閉じ込める。`tool.requiresScope` を持つ tool
 * (= PR2 の write tool) は scope と突合して 403 相当 (isError) を返す。PR1 の read
 * tool は requiresScope を持たないので gating は no-op。
 *
 * SDK (+ ajv) は workers-pool テスト loader と相性が悪いため、このモジュールは
 * `index.ts` から `/mcp` 到達時のみ遅延 import される。ロジックは `tools.ts` /
 * `cf-api.ts` を直接テストする (vitest.config.ts の coverage exclude 参照)。
 */
import { createWorkerMcp } from "@ippoan/mcp-cf-workers";
import type { z } from "zod";
import type { Env } from "../env";
import type { BindingJwtClaims } from "../middleware/binding-jwt";
import { CfAccessClient } from "../lib/cf-api";
import type { ToolEntry } from "./registry";
import { ALL_TOOLS } from "./tools";
import { isToolAllowed, parseScopes } from "./scope";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}
function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

// McpServer は SDK 内部型なので、ループ登録で cb 型を緩めるために必要な shape
// だけ要求する。raw shape (ZodObject.shape) を渡すのは echo-do-ws / ui-preview と
// 同じ呼び出し方 (SDK が validate する)。
interface RegisterableServer {
  registerTool: (
    name: string,
    config: { description: string; inputSchema: z.ZodRawShape },
    cb: (args: Record<string, unknown>) => Promise<ToolResult>,
  ) => unknown;
}

function registerToolEntry(
  server: RegisterableServer,
  env: Env,
  tool: ToolEntry<z.ZodTypeAny>,
  scopes: Set<string>,
  scopeLabel: string,
): void {
  const shape = (tool.inputSchema as z.ZodObject<z.ZodRawShape>).shape;
  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: shape },
    async (args: Record<string, unknown>): Promise<ToolResult> => {
      if (!isToolAllowed(tool, scopes)) {
        return fail(
          `forbidden: tool ${tool.name} requires scope "${tool.requiresScope}", got "${scopeLabel}"`,
        );
      }
      const parsed = tool.inputSchema.safeParse(args ?? {});
      if (!parsed.success) {
        return fail(`invalid arguments: ${parsed.error.message}`);
      }
      let token: string;
      try {
        token = await env.CF_ZEROTRUST_API_TOKEN.get();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return fail(`failed to read CF token binding: ${msg}`);
      }
      const client = new CfAccessClient({ accountId: env.CF_ACCOUNT_ID, token });
      try {
        return ok(await tool.execute(client, parsed.data));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

/** `/mcp` に mount する stateless ハンドラ。claims は binding_jwt middleware が立てたもの。 */
export async function handleMcp(
  request: Request,
  env: Env,
  claims?: BindingJwtClaims,
): Promise<Response> {
  const scopes = parseScopes(claims?.scope);
  const scopeLabel = claims?.scope ?? "";

  const handler = createWorkerMcp<Env>({
    name: "cf-access-mcp",
    version: "0.1.0",
    registerTools: (server, e) => {
      const reg = server as unknown as RegisterableServer;
      for (const tool of ALL_TOOLS) {
        registerToolEntry(reg, e, tool, scopes, scopeLabel);
      }
    },
  });

  return handler(request, env);
}
