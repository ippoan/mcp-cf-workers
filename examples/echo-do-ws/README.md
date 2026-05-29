# Phase 0 PoC — echo MCP over DO + WebSocket (Gate A trigger)

Validates the **hard gate** for [ippoan/mcp-cf-workers#6] /
[ippoan/secrets-inventory#70]:

> deploy → WS drop → Claude Code auto-reconnects → `tools/list` re-fetched

If this gate passes, the DO+WS transport is the real fix for #70 and we proceed
with the consumer migration. If Claude Code does **not** re-fetch `tools/list`
after a deploy, we fall back to secrets-inventory#70 option ③ (document that a
manual reconnect is required).

[ippoan/mcp-cf-workers#6]: https://github.com/ippoan/mcp-cf-workers/issues/6
[ippoan/secrets-inventory#70]: https://github.com/ippoan/secrets-inventory/issues/70

## What it serves

- `echo` — echoes back, prefixed with `BUILD_TAG` so you can see which deploy
  answered.
- `bump_version` — registers `echo_v2` at runtime and pushes
  `notifications/tools/list_changed` (proves the listChanged push works **without
  a reconnect**, separate from the deploy path).

## Deploy

### Option A — GitHub Actions (no local Cloudflare creds needed)

The **`deploy example echo-do-ws`** workflow **auto-deploys on every push to
`main`** that touches this example or the lib `src/` it bundles, baking
`BUILD_TAG = <commit SHA>` so each deploy is a distinct, visible version. It uses
the repo's `CLOUDFLARE_API_TOKEN` secret and prints the `…/mcp` endpoint in the
run summary. You can also dispatch it manually (Actions → Run workflow) with an
explicit `build_tag`.

### Option B — local wrangler

```sh
cd examples/echo-do-ws
npm install
npx wrangler deploy
```

Note the deployed URL, e.g. `https://echo-do-ws.<subdomain>.workers.dev`. The MCP
endpoint is `…/mcp`.

## Connect from Claude Code

```sh
claude mcp add --transport http echo-do-ws https://echo-do-ws.<subdomain>.workers.dev/mcp
```

(Use `--transport sse` if you set `transport: "sse"` in `mountDurableMcp`.)

## Hard gate A — deploy → reconnect → re-list (the #70 gate)

1. Start a Claude Code session and run `/mcp` (or list tools). Confirm `echo` /
   `bump_version` are present and note the tag `echo` answers with.
2. **Keep the session open.** Trigger a re-deploy with a new tag: just push to
   `main` (auto-deploy bakes the new commit SHA), or dispatch the workflow with
   an explicit `build_tag`, or locally bump `BUILD_TAG` and `npx wrangler deploy`.
3. In the **same** session, call `echo` again.
   - ✅ **Gate passes** if, after the deploy, the client reconnects and `echo`
     now reports the **new** tag (and any newly added tool appears) **without
     manually re-adding the server**.
   - ❌ **Gate fails** if the session still reports the **old** tag / the
     tool-set is frozen until you restart the session.

Record the result on #6 Phase 0.

## Hard gate B — runtime listChanged push (no deploy)

1. In a live session, call `bump_version`.
2. Confirm the client picks up `echo_v2` without reconnecting (it received
   `notifications/tools/list_changed` and re-ran `tools/list`).

## Notes

- `BUILD_TAG` is just a visible marker; any redeploy restarts the DO and drops
  the WS regardless.
- WebSocket Hibernation does **not** survive a deploy ("Code updates disconnect
  all WebSockets"). The fix relies on the *reconnect*, not on surviving the
  deploy. Hibernation only compresses idle billing.
