/**
 * MCP transport 配線。
 *
 * @ippoan/mcp-cf-workers の `createWorkerMcpV2` (MCP 2026-07-28 / SDK v2、
 * legacy 2025 クライアントも同一エンドポイントで serve) に registry の tool を
 * 登録するだけの薄い 1 枚。実ロジックは `./tools` (pure) と `../lib/cf-api`
 * (CF REST client) に置き、ここはそれを MCP tool として公開するアダプタに
 * 徹する (SDK / transport 依存はこのファイルに閉じる)。
 *
 * scope gating: v1 時代は request ごとに factory を作り claims を closure に
 * 閉じ込めていたが、v2 では SDK 公式の `authInfo` pass-through に載せる:
 * binding_jwt middleware の claims を `AuthInfo` に写して handler の第3引数で
 * 渡し、per-request factory が `ctx.authInfo.scopes` で gating する
 * (Refs ippoan/mcp-cf-workers#66)。
 *
 * SDK は workers-pool テスト loader と相性が悪いため、このモジュールは
 * `index.ts` から `/mcp` 到達時のみ遅延 import される。ロジックは `tools.ts` /
 * `cf-api.ts` を直接テストする (vitest.config.ts の coverage exclude 参照)。
 */
import { createWorkerMcpV2 } from "@ippoan/mcp-cf-workers";
import type { AuthInfo } from "@modelcontextprotocol/server";
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
// だけ要求する。SDK v2 の inputSchema は Standard Schema — zod v4 の ZodObject を
// `.shape` に崩さずそのまま渡す (v1 との差分)。
interface RegisterableServer {
  registerTool: (
    name: string,
    config: { description: string; inputSchema: z.ZodTypeAny },
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
  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: tool.inputSchema },
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

// module-scope で一度だけ生成 (v2 の memoize 設計に乗る)。per-request の
// caller 情報は closure ではなく ctx.authInfo から読む。
const handler = createWorkerMcpV2<Env>({
  name: "cf-access-mcp",
  version: "0.1.0",
  registerTools: (server, env, ctx) => {
    const scopes = new Set(ctx.authInfo?.scopes ?? []);
    const scopeLabel = ctx.authInfo?.scopes.join(" ") ?? "";
    const reg = server as unknown as RegisterableServer;
    for (const tool of ALL_TOOLS) {
      registerToolEntry(reg, env, tool, scopes, scopeLabel);
    }
  },
});

/** binding_jwt claims → SDK `AuthInfo`。token は WWW-Authenticate を立てた元の Bearer。 */
function toAuthInfo(request: Request, claims: BindingJwtClaims): AuthInfo {
  const authorization = request.headers.get("authorization") ?? "";
  return {
    token: authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "",
    clientId: claims.sub,
    scopes: [...parseScopes(claims.scope)],
    expiresAt: claims.exp,
  };
}

/** `/mcp` に mount する stateless ハンドラ。claims は binding_jwt middleware が立てたもの。 */
export async function handleMcp(
  request: Request,
  env: Env,
  claims?: BindingJwtClaims,
): Promise<Response> {
  return handler(request, env, claims ? { authInfo: toAuthInfo(request, claims) } : undefined);
}
