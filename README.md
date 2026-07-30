# Unify

Unify is a Windows-first Cursor extension that connects Claude and ChatGPT subscriptions through a local, authenticated inference gateway.

## Current scope

- Cursor on Windows x64
- Claude and ChatGPT OAuth
- OpenAI-compatible `/v1/models` and `/v1/chat/completions`
- Streaming text and tool calls
- Cloudflare Quick Tunnel with checksum-verified `cloudflared`
- Manual, prompted, and fully automatic tunnel startup
- Default, Carbon, Incognito, Aquamint, Sophisticated, Wock, and Light dashboard themes
- Optional floating synapse background
- Configurable model names, backend IDs, and visibility
- Global reasoning effort and speed controls
- Per-model token usage for the last 30 days
- Status-bar controls for changing effort and speed
- GitHub-style daily prompt activity for the last year
- Expandable local history for the latest 10 prompts and results
- Automatic fallback when the preferred local gateway port is occupied
- Prompted or automatic Cursor restarts that apply every new tunnel URL

## Install

1. Install `dist/unify-1.0.1.vsix`:

   ```powershell
   cursor --install-extension .\dist\unify-1.0.1.vsix
   ```

2. Restart Cursor and open **Unify** from the status bar.
3. Connect Claude and ChatGPT.
4. Start the tunnel.
5. In **Cursor Settings → Models**:
   - Paste Unify's Base URL into **Override OpenAI Base URL**.
   - Paste Unify's bridge key into **OpenAI API Key**.
   - Add the enabled names from Unify's **Models** tab as custom models.

This setup is normally performed once. Unify keeps the Quick Tunnel process alive across ordinary Cursor restarts and reconnects its local gateway to the same URL. When Cloudflare assigns a new URL, Unify can fully restart Cursor, write the URL while Cursor is closed, and relaunch it.

## Tunnel startup

The setting is under **Unify → Settings → Tunnel startup**:

- **No automatic tunneling** — start it from the dashboard.
- **Prompted tunneling** — ask before starting when needed. This is the default.
- **Fully automatic tunneling** — start without prompting when needed.

An already-running persistent tunnel is reused in all three modes.

## Cursor setup

The **Cursor URL** setting has two modes:

- **Prompt to restart** — ask before fully restarting Cursor and applying a new tunnel URL. This is the default.
- **Restart automatically** — apply a new tunnel URL without an Unify confirmation.

Cursor may still show its own save confirmation for unsaved files. Unify preserves the rest of Cursor's state record, changes only the Base URL, and relaunches Cursor after the write.

## Models

The **Models** tab controls what Cursor sees. Effort and Speed apply globally to every routed request. Each model row has:

- **Cursor name** — the model name added to Cursor.
- **Backend ID** — the exact model ID sent to Claude or ChatGPT.
- **Shown** — whether the model appears in the OpenAI-compatible model list.

The initial Claude names are `Sonnet 5`, `Fable 5`, and `Opus 5`. The initial OpenAI names are `Sol`, `Terra`, and `Luna`. Backend IDs are editable because provider identifiers can differ by account or change over time.

Unify applies the selected global effort and speed to requests routed through every configured model. For ChatGPT, Fast selects priority service; for Claude, Fast requests the provider's fast service mode.

The overview aggregates input and output tokens by model for the last 30 days, completed prompt counts by day for the last year, and local request history. The latest 10 completed user requests retain their prompt and final result as plain text in Cursor's local extension state. Returned tool calls are stored as readable JSON.

## Experiments

- **Local Mode** points Cursor directly at Unify's loopback gateway and stops Quick Tunnel. It works only when the current Cursor request path can reach the local machine.
- **Deep Prompt** lets the model selected in Cursor complete its normal tool-calling loop. Tool calls and length-limited responses pass through unchanged. Once the model produces final text, Unify sends it through the configured tool-free validator while preserving Cursor's response style.

## Security model

- The inference gateway binds only to `127.0.0.1`.
- The public tunnel exposes only authenticated model and completion routes.
- There is no HTTP settings, OAuth, analytics, or logging control plane.
- OAuth credentials and the bridge key use Cursor's encrypted secret storage.
- Requests are protected by a 256-bit bearer key, body limits, rate limits, and concurrency limits.
- Only the latest 10 prompt/result history entries are stored locally. Images and authorization headers are not retained.
- The downloaded Windows `cloudflared` binary is pinned to `2026.7.3` and verified with Cloudflare's published SHA-256 checksum.

Treat the Quick Tunnel URL and bridge key as credentials. Use **Rotate key** and **Stop** if either may have leaked.

## Quick Tunnel limitation

Cloudflare describes Quick Tunnels as a development feature and does not officially guarantee Server-Sent Events. Unify forwards streaming responses without buffering, but streaming through Cloudflare must still be validated on the target Windows and Cursor versions.

## Development

```powershell
npm install
npm run check
npm run package
```

The packaged extension is written to `dist/unify-1.0.1.vsix`.

## Use

Unify is intended for the account owner's personal use. Review and follow each provider's terms for subscription and OAuth access.
