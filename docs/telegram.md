# Telegram control

Settings → Telegram connects a bot while Aiden is running. Save its token, choose a model and review its access, then connect. For an unpaired profile, choose **Start pairing** and send the displayed `/start <code>` command to the bot from your own Telegram account. The command authorizes that account, so keep it private.

The command expires after five minutes and works once. A plain `/start`, unsolicited message, edited message, callback, reaction or group message cannot claim an unpaired bot. Ten wrong attempts exhaust a profile's proof; a shared limit allows at most 100 attempts in five minutes across profiles. Start pairing again after expiry or exhaustion. Existing saved owners continue working after an upgrade; startup never opens pairing automatically.

Cancel, Reset pairing, disconnect, disable, token changes, switching profiles and quitting invalidate pending pairing. Reset also removes the saved owner, clears queued work and thread targets, stops the active Telegram turn, disables existing Bot bindings and revokes the old owner's Bot notice audience. It requires another explicit Start pairing action. Disconnect or disable retains the saved owner. Pairing proofs stay in memory and are never included in status, chat history or message logs.

## Workspace access

Assistant-only mode has no project files or tools. Selecting a configured folder in Settings or `/workspace` explicitly grants unattended project automation: Telegram can edit files and run commands without an approval prompt, including in an **Ask** workspace. The Settings access review and workspace selector disclose this separate grant. Use `/workspace off` to return to Assistant-only mode.

**No Access** blocks ordinary Telegram project work. Such folders cannot be selected or provisioned as new workspace topics. Existing topics remain available for separately authorized Bot bindings; ordinary work on them is denied. Saved denied selections fail with an explanation; Aiden never silently changes their scope. A downgrade removes queued ordinary Telegram work and cancels active ordinary work; dispatch, generation and compaction confirmation recheck access as well. Reply preparation revalidates authority, and each actual text, edit, draft, activity, typing, file or voice request checks currentness and cancellation immediately before it starts. Revocation prevents subsequent requests, including fallback/error delivery; it cannot retract a request already started before revocation.

Bots keep their own managed homes and capability policies. Denying ordinary workspace access does not revoke separately granted Bot authority. Bot bindings still require the exact saved Telegram owner, route and enabled binding.

The standalone CLI retains its explicit terminal configuration: `telegram configure` supplies a positive owner ID and requires a registered workspace with Full access. It does not claim the first sender or depend on desktop pairing. See [CLI guide](../packages/cli/README.md).

## Verification

`npm run build:lease-flock` prepares the native lease helper in a fresh checkout. `npm run test:telegram` covers pairing, ownership continuity, settings handlers, workspace selection, queue revocation, Bot routing and rendering of the pairing controls without network requests. Attended pairing with a real bot and a second Telegram account remains an acceptance check.
