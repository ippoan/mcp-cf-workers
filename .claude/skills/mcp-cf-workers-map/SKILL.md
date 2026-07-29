---
name: mcp-cf-workers-map
generated-from: mcp-cf-workers:a55568df1839a7ccf103340c0acea9ef03fb0097
paths: [src/]
description: ippoan/mcp-cf-workers (Cloudflare Run MCP factory) の構造ナビゲーション。durable (DO+WS) path の構成・agents SDK 依存分離・Phase 0 hard gate 実機検証結果 (listChanged / Claude Code クライアント欠落) を収録。トリガー:「mcp-cf-workers」「durable path」「McpAgent」「listChanged」「tools/list_changed」「Phase 0 hard gate」「DO+WS」「createDurableMcp」「echo-do-ws」「createWorkerMcpV2」「factory v2」「MCP 2026-07-28」等。
---

# mcp-cf-workers-map

ippoan/mcp-cf-workers (Cloudflare Workers 上の MCP server factory) の構造 map。
CLAUDE.md は骨格化されているため、architecture / 実機検証記録はここを参照する。

## 区画

- `src/factory.ts` / `src/auth/` — stateless `createWorkerMcp` + CF Access 認証 helper (framework-agnostic core)
- `src/factory-v2.ts` — MCP 2026-07-28 対応の `createWorkerMcpV2` (SDK v2 = `@modelcontextprotocol/server`、optional peer)。v1 と併存。詳細は下記「factory v2」参照
- `src/durable.ts` / `src/durable-server.ts` / `src/durable-mount.ts` — DO+WS (stateful) path。詳細は下記「CLAUDE.md から移設」参照
- `src/index.ts` — named export の公開 API surface
- `examples/echo-do-ws` — Phase 0 実機検証で使った PoC worker

## factory v2 — MCP 2026-07-28 対応 (Refs #66, 2026-07-29)

- `createWorkerMcpV2` は SDK v2 の `createMcpHandler` を包む。**両 era を同一
  エンドポイントで serve**: modern (2026-07-28、`_meta` envelope) はネイティブ、
  legacy (2025 年代 `initialize`) は既定 `legacy:'stateless'` でリクエスト毎
  ステートレス応答 (= v1 factory と同じ姿勢なので既存 claude.ai connector は
  無変更で動く)。`handlerOptions: { legacy: 'reject' }` で modern 専用化
- `createMcpHandler` は「一度生成して使い回す」設計だが、Workers の `env` は
  リクエスト毎引数なので **env の object identity で memoize** している
  (isolate 内では同一 object → 実質一度だけ生成。テストで env を替えると再生成)。
  異なる env object を交互に投げると memo が振動するのでテスト以外ではしない
- **SDK v2 の registerTool は inputSchema が Standard Schema** (`z.object({...})`)。
  v1 の raw shape (`{ message: z.string() }`) は不可 — consumer 移行時の主な書き換え点
- authInfo は handler が header から導出しない (SDK v2 設計)。返り値 handler の
  第3引数 `{ authInfo }` で注入し、tool handler は `ctx.http.authInfo` で読む
  (binding-jwt の検証結果を渡す想定)
- `@modelcontextprotocol/server` は **optional peer** (v1 のみ使う consumer に
  強制しない)。devDep は exact pin。v1 SDK peer の削除は 12ヶ月 window 後の
  メジャー bump で (#66 Phase 4)

## CLAUDE.md から移設 (2026-07-06)

## durable (DO+WS) path の構成 (Refs #6)

- `./durable` export は Cloudflare `agents` SDK の `McpAgent` をそのまま借りた
  stateful transport。`agents` は **optional peer dep** (durable path 利用時のみ)
- `agents/mcp` は `cloudflare:workers` を import するため **node (vitest) では
  読めない**。なので agents 非依存の純粋ロジック (server 構築 =
  `durable-server.ts` / edge mount 配線 = `durable-mount.ts`) と agents 依存の
  薄い DO factory (`durable.ts` の `createDurableMcp`) を分離している。前者 2 つは
  InMemoryTransport / stub で node テスト、後者は `vi.mock("agents/mcp")` で
  テストする。新ロジックを足す時はこの分離を保つこと
- `listChanged` capability は `DURABLE_MCP_CAPABILITIES` で single-source。
  stateless `createWorkerMcp` は push 不可なので listChanged を宣言しない

## Phase 0 hard gate 実機検証結果 (Refs #12 / #6, 2026-05-29)

`examples/echo-do-ws` を deploy し、ライブ Claude Code (Web) session +
素の MCP クライアント (curl) の両方で実測した確定事項。**ここを誤解すると
listChanged 周りで無駄な「サーバ修正」を繰り返すので必読。**

### サーバ側 (echo-do-ws / 本 lib) は 100% spec 準拠 — ワイヤレベルで実証済み

curl (= 素の Streamable HTTP クライアント) で同一 `mcp-session-id` を維持して検証:

1. `initialize` → `capabilities.tools.listChanged: true` を宣言 ✅
2. `GET /mcp` (with session-id) → `200 text/event-stream`。server-initiated
   通知用の GET SSE stream を**ちゃんと開く** ✅
3. `bump_version` (= `server.registerTool` + `server.sendToolListChanged()`)
   → **GET SSE stream に `notifications/tools/list_changed` が実際に届く** ✅
   (curl で wire 上に捕捉済み)
4. 同一 session の `tools/list` に runtime 登録した `echo_v2` が出る ✅

→ register/enable/disable/update + 自動 list_changed push は **MCP SDK
(`@modelcontextprotocol/sdk` の `McpServer`) 標準機能**。我々は自作していない。
サーバ側に欠陥は無い。`additionalProperties:false` の strict schema 等の
「サーバを直す」系の対処は **listChanged 不達の原因ではない**ので入れても無駄。

### 詰まりは一点: Claude Code クライアントが wire 上の通知を消費しない

- 上記 curl では echo_v2 が出るのに、**Claude Code Web session の tool list には
  出ない** (same-turn / cross-turn 両方で ✗ を実測)。
- root cause: Claude Code の MCP クライアントは `notifications/tools/list_changed`
  の Zod schema を持つが **`setNotificationHandler` を一度も呼んでいない**
  (decompiled cli.js で確認済み)。`_onnotification` がハンドラ無しで早期 return。
- = SDK にフック (`client.setNotificationHandler`) はあるが、その上の
  Claude Code アプリが配線していない。**サーバ側からは直せない (upstream 案件)。**

### 判定 (#6 Phase 0)

| Gate | 内容 | 結果 |
|------|------|------|
| **A** | deploy → WS drop → 自動再接続 → initialize/tools-list 再取得 | ✅ **PASS** (`echo` の BUILD_TAG が同一 session のまま `605466d`→`e5351ac` に更新) |
| **B** | runtime `bump_version` → 再接続なしで `echo_v2` 反映 | ❌ **FAIL** (クライアント欠落。サーバは正しく push 済み) |

- **#70 の実害 (deploy で schema 変化 → live session が旧 schema で固まる) は
  Gate A = reconnect で解決する。** DO+WS 移行はこの用途で価値がある。
- runtime listChanged push が Web で効かないのは別問題 (クライアント欠落) で、
  #70 のクローズ条件には影響しない。secrets-inventory#70 を対応案③ (再接続必須を
  明記) に後退させる必要は**ない**。
- optional param 追加程度なら inputSchema を `additionalProperties:true` に
  しておくと旧 schema を握ったクライアントでも素通りする (reconnect すら不要)。

### 参照ソース

- 実機検証 issue: ippoan/mcp-cf-workers#12 (本 PoC), epic #6, ippoan/secrets-inventory#70
- Claude Code クライアント欠落:
  - anthropics/claude-code#13646 ([Bug] tool list not refreshed on list_changed)
  - anthropics/claude-code#4118 (list_changed 対応の本流 issue)
  - anthropics/claude-code#31893 (MCP spec compliance: same-turn ✗ / cross-turn ✓ の挙動表)
- MCP spec: [Transports — Streamable HTTP (2025-03-26)](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)
  (server-initiated 通知は client が開く GET SSE stream 経由で配送)
- MCP SDK 動的 tool 管理: `McpServer.registerTool` の戻り値ハンドル
  `.update()/.enable()/.disable()/.remove()` が自動で list_changed を push
