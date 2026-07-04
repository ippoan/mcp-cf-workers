/**
 * Cloudflare Zero Trust (Access) tools。
 *
 * 各 tool は SDK / transport 非依存の pure logic で、token 注入済みの
 * {@link CfAccessClient} を受け取って CF REST を叩くだけ。これにより node 上で
 * client を fake に差し替えて直接テストできる (server.ts の SDK 配線はテスト対象外)。
 *
 * - read (PR1): `requiresScope` を付けない (= binding_jwt が valid なら誰でも)。
 * - write (PR2): `requiresScope: "mcp.write"` を付け、server.ts が binding_jwt の
 *   scope と突合して 403 相当を返す。
 */
import { z } from "zod";
import type { AccessInclude } from "../lib/cf-api";
import type { ToolEntry } from "./registry";

const noArgs = z.object({}).strict();

// ===== read tools (PR1) =====================================================

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

const listAuditLogsArgs = z
  .object({
    // CF Audit Log v2 API は since/before を必須とする (公式ドキュメントは「全
    // パラメータ optional」と記載しているが実機では両方必須、無いと
    // `HTTP 400 "query parameter 'since'/'before' is required"`、2026-07-04 確認)。
    since: z.string().describe("ISO8601 timestamp (必須)。この時刻以降のイベントのみ。"),
    before: z.string().describe("ISO8601 timestamp (必須)。この時刻より前のイベントのみ。"),
    actor_email: z.string().optional().describe("操作した actor のメールアドレスで絞り込む。"),
    resource_product: z
      .string()
      .optional()
      .describe("対象 product で絞り込む (例 access / workers / dns)。"),
    limit: z.number().int().min(1).max(1000).optional().describe("返す件数。"),
    cursor: z
      .string()
      .optional()
      .describe("次ページ取得用 cursor (前回応答の result_info.cursors.after 等)。"),
  })
  .strict();

export const listAuditLogsTool = {
  name: "list_audit_logs",
  description:
    "List Cloudflare account Audit Log entries (read-only). since/before " +
    "(ISO8601) are REQUIRED by the CF API — pass a time range (e.g. last 24h). " +
    "Use actor_email/resource_product to further narrow down who changed what " +
    "and when (e.g. custom domain / DNS / secret changes). Requires the CF API " +
    "token to have the 'Account Settings: Read' scope.",
  inputSchema: listAuditLogsArgs,
  execute: (client, args) =>
    client.listAuditLogs({
      since: args.since,
      before: args.before,
      actorEmail: args.actor_email,
      resourceProduct: args.resource_product,
      limit: args.limit,
      cursor: args.cursor,
    }),
} satisfies ToolEntry<typeof listAuditLogsArgs>;

// ===== write tools (PR2) ====================================================

const WRITE = "mcp.write" as const;

/**
 * allow 指定 (emails / email_domains / everyone) を CF の include[] に変換する。
 * `everyone` は「認証さえ通れば誰でも」(IdP 未指定なら One-time PIN)。
 */
export function buildInclude(allow: {
  emails?: string[];
  email_domains?: string[];
  everyone?: boolean;
}): AccessInclude[] {
  const include: AccessInclude[] = [];
  if (allow.everyone) include.push({ everyone: {} });
  for (const email of allow.emails ?? []) include.push({ email: { email } });
  for (const domain of allow.email_domains ?? []) include.push({ email_domain: { domain } });
  return include;
}

const allowSchema = z
  .object({
    emails: z.array(z.string().min(1)).optional().describe("許可する個別メールアドレス。"),
    email_domains: z
      .array(z.string().min(1))
      .optional()
      .describe("許可するメールドメイン (例 ippoan.org)。"),
    everyone: z
      .boolean()
      .optional()
      .describe("true で認証済みなら誰でも許可 (IdP 未指定は One-time PIN)。"),
  })
  .strict();

const createAccessPolicyArgs = z
  .object({
    name: z.string().min(1).describe("policy 名。"),
    decision: z.enum(["allow", "deny", "non_identity", "bypass"]).default("allow"),
    allow: allowSchema,
  })
  .strict();

export const createAccessPolicyTool = {
  name: "create_access_policy",
  description:
    "Create a reusable Access policy. allow の emails / email_domains / everyone は " +
    "CF の include[] rule に変換される。",
  inputSchema: createAccessPolicyArgs,
  requiresScope: WRITE,
  execute: async (client, args) => {
    const include = buildInclude(args.allow);
    if (include.length === 0) {
      throw new Error("allow must specify at least one of emails / email_domains / everyone");
    }
    return client.createAccessPolicy({ name: args.name, decision: args.decision, include });
  },
} satisfies ToolEntry<typeof createAccessPolicyArgs>;

const uidArgs = z.object({ uid: z.string().min(1) }).strict();

export const deleteAccessPolicyTool = {
  name: "delete_access_policy",
  description: "Delete a reusable Access policy by uid.",
  inputSchema: uidArgs,
  requiresScope: WRITE,
  execute: (client, args) => client.deleteAccessPolicy(args.uid),
} satisfies ToolEntry<typeof uidArgs>;

const createAccessAppArgs = z
  .object({
    name: z.string().min(1),
    domain: z.string().min(1).describe("保護する hostname (例 egov-staging.ippoan.org)。"),
    type: z.string().default("self_hosted"),
    policies: z.array(z.string()).optional().describe("適用する policy uid のリスト。"),
    allowed_idps: z.array(z.string()).optional().describe("許可する IdP id (空なら One-time PIN)。"),
  })
  .strict();

export const createAccessAppTool = {
  name: "create_access_app",
  description: "Create a self_hosted Access application. Returns the app uid and aud.",
  inputSchema: createAccessAppArgs,
  requiresScope: WRITE,
  execute: (client, args) =>
    client.createAccessApp({
      name: args.name,
      type: args.type,
      domain: args.domain,
      policies: args.policies,
      allowed_idps: args.allowed_idps,
    }),
} satisfies ToolEntry<typeof createAccessAppArgs>;

const updateAccessAppArgs = z
  .object({
    uid: z.string().min(1),
    patch: z
      .record(z.string(), z.unknown())
      .describe("更新するフィールド (CF は full replace なので name/domain/policies 等を渡す)。"),
  })
  .strict();

export const updateAccessAppTool = {
  name: "update_access_app",
  description: "Update an Access application by uid (PUT, CF は full replace)。",
  inputSchema: updateAccessAppArgs,
  requiresScope: WRITE,
  execute: (client, args) => client.updateAccessApp(args.uid, args.patch),
} satisfies ToolEntry<typeof updateAccessAppArgs>;

export const deleteAccessAppTool = {
  name: "delete_access_app",
  description: "Delete an Access application by uid.",
  inputSchema: uidArgs,
  requiresScope: WRITE,
  execute: (client, args) => client.deleteAccessApp(args.uid),
} satisfies ToolEntry<typeof uidArgs>;

// ----- 高レベル便利 tool: protect_hostname -----

const protectHostnameArgs = z
  .object({
    hostname: z.string().min(1).describe("保護する hostname (例 egov-staging.ippoan.org)。"),
    allow: allowSchema,
    allowed_idps: z.array(z.string()).optional().describe("許可する IdP id (空なら One-time PIN)。"),
    app_name: z.string().optional().describe("Access app 名 (省略時は hostname)。"),
  })
  .strict();

export const protectHostnameTool = {
  name: "protect_hostname",
  description:
    "高レベル便利 tool: hostname を CF Access で保護する。allow policy を作成 → " +
    "self_hosted app を作成し、{ app_uid, aud, policy_id } を返す。これにより未認証 " +
    "リクエストは edge でログインへ 302 され、Worker invocation が 0 になる " +
    "(bot の辞書スキャン対策)。",
  inputSchema: protectHostnameArgs,
  requiresScope: WRITE,
  execute: async (client, args) => {
    const include = buildInclude(args.allow);
    if (include.length === 0) {
      throw new Error("allow must specify at least one of emails / email_domains / everyone");
    }
    const policy = await client.createAccessPolicy({
      name: `protect ${args.hostname}`,
      decision: "allow",
      include,
    });
    const policyId = typeof policy.id === "string" ? policy.id : undefined;
    if (!policyId) {
      throw new Error(`policy creation did not return an id: ${JSON.stringify(policy)}`);
    }
    const app = await client.createAccessApp({
      name: args.app_name ?? args.hostname,
      type: "self_hosted",
      domain: args.hostname,
      policies: [policyId],
      allowed_idps: args.allowed_idps ?? [],
    });
    return {
      app_uid: app.uid ?? app.id,
      aud: app.aud,
      policy_id: policyId,
      domain: args.hostname,
    };
  },
} satisfies ToolEntry<typeof protectHostnameArgs>;

// ===== registry =============================================================

/**
 * read tools。`requiresScope` 無し (binding_jwt が valid なら誰でも)。
 * 各 tool の inputSchema が異なるため `ToolEntry<z.ZodTypeAny>` に揃えて束ねる。
 */
export const READ_TOOLS: ToolEntry<z.ZodTypeAny>[] = [
  listAccessAppsTool as unknown as ToolEntry<z.ZodTypeAny>,
  getAccessAppTool as unknown as ToolEntry<z.ZodTypeAny>,
  listAccessPoliciesTool as unknown as ToolEntry<z.ZodTypeAny>,
  listServiceTokensTool as unknown as ToolEntry<z.ZodTypeAny>,
  listIdentityProvidersTool as unknown as ToolEntry<z.ZodTypeAny>,
  listAccessGroupsTool as unknown as ToolEntry<z.ZodTypeAny>,
  listAuditLogsTool as unknown as ToolEntry<z.ZodTypeAny>,
];

/** write tools。すべて `requiresScope: "mcp.write"`。 */
export const WRITE_TOOLS: ToolEntry<z.ZodTypeAny>[] = [
  createAccessPolicyTool as unknown as ToolEntry<z.ZodTypeAny>,
  deleteAccessPolicyTool as unknown as ToolEntry<z.ZodTypeAny>,
  createAccessAppTool as unknown as ToolEntry<z.ZodTypeAny>,
  updateAccessAppTool as unknown as ToolEntry<z.ZodTypeAny>,
  deleteAccessAppTool as unknown as ToolEntry<z.ZodTypeAny>,
  protectHostnameTool as unknown as ToolEntry<z.ZodTypeAny>,
];

/** server.ts が McpServer に登録する全 tool。 */
export const ALL_TOOLS: ToolEntry<z.ZodTypeAny>[] = [...READ_TOOLS, ...WRITE_TOOLS];
