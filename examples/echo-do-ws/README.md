# Phase 0 PoC — echo MCP over DO + WebSocket

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

Run the **`deploy example echo-do-ws`** workflow (Actions tab → Run workflow)
with a `build_tag` input (default `v1`). It deploys using the repo's
`CLOUDFLARE_API_TOKEN` secret and prints the `…/mcp` endpoint in the run summary.
To exercise the deploy half of the gate, run it again with `build_tag=v2`.

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
   `bump_version` are present and `echo` answers with `v1: …`.
2. **Keep the session open.** Re-deploy with a new tag: re-run the Actions
   workflow with `build_tag=v2` (Option A), or change `BUILD_TAG` in
   `wrangler.toml` and `npx wrangler deploy` (Option B).
3. In the **same** session, call `echo` again.
   - ✅ **Gate passes** if, after the deploy, the client reconnects and `echo`
     now answers `v2: …` (and any newly added tool appears) **without manually
     re-adding the server**.
   - ❌ **Gate fails** if the session still answers `v1: …` / the tool-set is
     frozen until you restart the session.

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
