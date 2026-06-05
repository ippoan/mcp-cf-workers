/**
 * Cloudflare Zero Trust (Access) read tools (PR1)。
 *
 * 各 tool は SDK / transport 非依存の pure logic で、token 注入済みの
 * {@link CfAccessClient} を受け取って CF REST を 1 本叩くだけ。これにより
 * node 上で client を fake に差し替えて直接テストできる (server.ts の SDK 配線は
 * テスト対象外)。
 *
 * read tool なので `requiresScope` は付けない (= binding_jwt が valid なら誰でも)。
 * write (create/update/delete) tools は PR2 で `requiresScope: "mcp.write"` 付きで
 * 追加する。
 */
import { z } from "zod";
import type { ToolEntry } from "./registry";

const noArgs = z.object({}).strict();

export const listAccessAppsTool = {
  name: "list_access_apps",
  description:
    "List Cloudflare Access applications in the account. " +
    "Returns each app's uid / name / domain / type / aud.",
  inputSchema: noArgs,
  execute: (client, _args) => client.listAccessApps(),
} satisfies ToolEntry<typeof noArgs>;

const getAccessAppArgs = z
  .object({
    uid: z.string().min(1).describe("Access application uid (from list_access_apps)."),
  })
  .strict();

export const getAccessAppTool = {
  name: "get_access_app",
  description: "Get a single Cloudflare Access application by uid.",
  inputSchema: getAccessAppArgs,
  execute: (client, args) => client.getAccessApp(args.uid),
} satisfies ToolEntry<typeof getAccessAppArgs>;

export const listAccessPoliciesTool = {
  name: "list_access_policies",
  description:
    "List reusable Cloudflare Access policies in the account " +
    "(name / decision / include rules).",
  inputSchema: noArgs,
  execute: (client, _args) => client.listAccessPolicies(),
} satisfies ToolEntry<typeof noArgs>;

export const listServiceTokensTool = {
  name: "list_service_tokens",
  description:
    "List Cloudflare Access service tokens (metadata only — client_secret is " +
    "never returned by this endpoint).",
  inputSchema: noArgs,
  execute: (client, _args) => client.listServiceTokens(),
} satisfies ToolEntry<typeof noArgs>;

export const listIdentityProvidersTool = {
  name: "list_identity_providers",
  description:
    "List Cloudflare Access identity providers. Use the returned id values for " +
    "an app's allowed_idps (e.g. to require Google login).",
  inputSchema: noArgs,
  execute: (client, _args) => client.listIdentityProviders(),
} satisfies ToolEntry<typeof noArgs>;

export const listAccessGroupsTool = {
  name: "list_access_groups",
  description: "List Cloudflare Access groups in the account.",
  inputSchema: noArgs,
  execute: (client, _args) => client.listAccessGroups(),
} satisfies ToolEntry<typeof noArgs>;

/**
 * 全 read tool。server.ts がこれをループして McpServer に登録する。
 * 各 tool の inputSchema が異なるため、`ToolEntry<z.ZodTypeAny>` に揃えて束ねる
 * (secrets-inventory registry と同じ手法)。
 */
export const READ_TOOLS: ToolEntry<z.ZodTypeAny>[] = [
  listAccessAppsTool as unknown as ToolEntry<z.ZodTypeAny>,
  getAccessAppTool as unknown as ToolEntry<z.ZodTypeAny>,
  listAccessPoliciesTool as unknown as ToolEntry<z.ZodTypeAny>,
  listServiceTokensTool as unknown as ToolEntry<z.ZodTypeAny>,
  listIdentityProvidersTool as unknown as ToolEntry<z.ZodTypeAny>,
  listAccessGroupsTool as unknown as ToolEntry<z.ZodTypeAny>,
];
