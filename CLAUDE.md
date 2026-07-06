# CLAUDE.md

Claude Code 向けの本リポジトリ作業ルール。

## Worktree / branch 命名規則

形式: `<issue-number>-<type>-<short-description>`

- `issue-number`: 必須。先に issue を立ててから worktree / branch を作る
- `type`: `feat` | `fix` | `refactor` | `infra`
- `short-description`: 半角小文字英数字とハイフン

例:

- `1-feat-factory-skeleton`
- `2-fix-jwks-cache-leak`

issue 番号を持たない branch (Claude Code が自動採番する `claude/...` 等)
で実装に入る前に、対応する issue を作成し、上記の形式で rename / 再切り出し
すること。

## PR description / commit message のキーワード

- 使用禁止: `Closes #N` / `Fixes #N` / `Resolves #N`
  - PR auto-merge が走った瞬間に issue が自動 close されるため、release 時の
    close 確認 UI と整合しない
- 使用推奨: `Refs #N` / `Related to #N` / `Part of #N`
  - GitHub の Development セクションには紐付くが auto-close されない
  - release tag 後に ci-dashboard 経由で目視 close する

PR テンプレートは `.github/pull_request_template.md` で `Refs` を強制する。

## このリポジトリの方針

- **薄く保つ**。SDK が出来ることはそのまま借りる (= `McpServer` /
  `WebStandardStreamableHTTPServerTransport`)。lib 側は wiring と
  framework-agnostic auth helper だけ
- consumer は peer dep 経由で SDK / hono / jose / zod を持ち込む (= 版固定は
  consumer 責任)
- Hono 依存は optional peer。core (`factory.ts` / `cf-access.ts`) は
  framework-agnostic
- 公開 API surface を小さく保つ。`./src/index.ts` / `./src/durable.ts` /
  `./src/auth/index.ts` の named export だけが SemVer 対象

詳細 (アーキテクチャ・経緯・gotcha) は mcp-cf-workers-map skill を参照。
