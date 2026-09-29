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

// ----- MUST_READ_FIRST (overview / index tool) -----

const INTRO = [
  "cf-access-mcp — 概要",
  "",
  "Cloudflare Zero Trust (Access) の app / policy / service token / audit log を扱う",
  "MCP server。CF API token は Worker 側の secret に閉じ、呼び出し側には渡らない。",
  "",
  "重要原則:",
  "  1. read 系 (list_* / get_access_app) は scope 不要。write 系 (create_* / delete_* /",
  "     update_access_app / protect_hostname) は binding_jwt の scope に `mcp.write` が",
  "     含まれているときだけ呼べる (無ければ 403 相当)。",
  "  2. `update_access_app` は CF の PUT = full replace。渡さなかった項目・policy は外れる。",
  "  3. `create_access_policy` は include を emails / email_domains / everyone しか表現できない。",
  "     それ以外の条件 (service_token / any_valid_service_token / group など) は",
  "     `update_access_app` の inline policy で作る (下の workflows / pitfalls を参照)。",
].join("\n");

const WORKFLOWS = {
  protect_hostname_by_email: [
    "hostname をメール (email / email_domains / everyone) で守る:",
    "",
    "  tools/call protect_hostname {",
    "    hostname: '<app>.example.com',",
    "    allow: { email_domains: ['example.com'] },",
    "  }",
    "",
    "allow policy 作成 → self_hosted app 作成を 1 発で行い、{ app_uid, aud, policy_id } を返す。",
  ].join("\n"),
  add_service_token_policy: [
    "service token 条件の policy を app に付ける:",
    "",
    "  1. token の発行は secrets-inventory MCP の `create_service_token`。",
    "     client_secret は GCP Secret Manager に直書きされ、context には出ない。",
    "  2. `get_access_app` で現状 (name / domain / type / session_duration / 既存 policies) を取る。",
    "  3. `update_access_app` の `patch.policies` に inline policy を入れる:",
    "",
    "     tools/call update_access_app {",
    "       uid: '<app uid>',",
    "       patch: {",
    "         name: '<現状の name>', domain: '<現状の domain>', type: 'self_hosted',",
    "         session_duration: '<現状の値>',",
    "         policies: [",
    "           { id: '<残す既存 reusable policy>', precedence: 1 },",
    "           { name: '<policy 名>', decision: 'non_identity',",
    "             include: [{ service_token: { token_id: '<token id>' } }], precedence: 2 }",
    "         ]",
    "       }",
    "     }",
    "",
    "既存の例は `list_access_policies` (decision=non_identity / include=service_token) で確かめられる。",
  ].join("\n"),
  update_access_app_is_full_replace: [
    "`update_access_app` は PUT の full replace:",
    "",
    "  - name / domain / type / session_duration と、**残したい既存 policy もすべて** patch に渡す。",
    "    渡さなかったものは外れる (policy が消えて app が無防備 / 全拒否になり得る)。",
    "  - 必ず先に `get_access_app` で現状を取り、それに差分を足した形で渡す。",
  ].join("\n"),
  workers_dev_hostname: [
    "workers.dev のホスト名も Access で守れる:",
    "",
    "  tools/call protect_hostname { hostname: '<worker>.<subdomain>.workers.dev', allow: { ... } }",
    "",
    "未認証リクエストは edge でログインへ 302 され、Worker invocation が 0 になる。",
  ].join("\n"),
};

const PITFALLS = [
  "`create_access_policy` で表現できない include (service_token / any_valid_service_token / group など) は " +
    "`update_access_app` の inline policy で作る。「この MCP では作れない」とユーザーにダッシュボード操作を頼む前に、" +
    "まずこれを試すこと。",
  "`update_access_app` は full replace。patch に残したい policy を含めないと外れる。先に `get_access_app`。",
  "write 系は `mcp.write` scope が要る。403 相当が返ったら scope を確認する。",
];

interface ReadFirstResult {
  intro: string;
  tools: Array<{ name: string; description: string; requires_scope?: string }>;
  workflows: typeof WORKFLOWS;
  pitfalls: string[];
}

export const readFirstTool = {
  // 名前・形は secrets-inventory の read-first tool に揃える (agent が同じ入口を期待できるように)。
  name: "MUST_READ_FIRST_or_other_tools_will_fail",
  description:
    "MUST READ FIRST BEFORE CALLING ANY OTHER TOOL ON THIS MCP SERVER. " +
    "Skipping this call leads to wrong conclusions such as \"this MCP cannot create that policy\" " +
    "(it can, via update_access_app inline policies), scope-denied responses, or policies being " +
    "dropped by update_access_app's full-replace semantics. " +
    "Returns: (1) server intro / 重要原則, (2) all other tool names + descriptions + required scopes, " +
    "(3) common workflows (protect a hostname by email / attach a service-token policy / " +
    "update_access_app full replace), (4) pitfalls. 入力 args 不要、CF API を呼ばず、いつでも呼べる。",
  inputSchema: noArgs,
  // client は使わない (CF REST を叩かない)。ALL_TOOLS は call 時に参照するので module 内の循環にならない。
  execute: async (): Promise<ReadFirstResult> => ({
    intro: INTRO,
    tools: ALL_TOOLS.filter((t) => t.name !== readFirstTool.name).map((t) => ({
      name: t.name,
      description: t.description,
      ...(t.requiresScope ? { requires_scope: t.requiresScope } : {}),
    })),
    workflows: WORKFLOWS,
    pitfalls: PITFALLS,
  }),
} satisfies ToolEntry<typeof noArgs>;

// ===== registry =============================================================

/**
 * read tools。`requiresScope` 無し (binding_jwt が valid なら誰でも)。
 * 各 tool の inputSchema が異なるため `ToolEntry<z.ZodTypeAny>` に揃えて束ねる。
 */
export const READ_TOOLS: ToolEntry<z.ZodTypeAny>[] = [
  readFirstTool as unknown as ToolEntry<z.ZodTypeAny>,
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
