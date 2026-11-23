# Subagent helper chat (give every helper its own chat, with no time limit)

Written 2026-11-22 from main at `1afb737c`. Built as one PR in three reviewed phases (the "PR 1/2/3" sections below are those phases). All three phases are implemented on `claude/subagent-helper-chat` (Phase 3, the helper chat, on 2026-11-22); the screenshots await approval.

**Decision on the 24-hour question:** option (a). "No limit" in attended chats is a 24-hour safety net; the safety grant keeps its 24-hour ceiling. Bots get 60 minutes per reply.

Three PRs turn today's Subagents inspector into a read-only chat for each helper, fix the bugs from your screenshot, and remove the 10-minute clock. Each PR lists what you'll notice, the build steps with the files they touch, the tests, and when it counts as done.



## What you decided

OptionC: full helper chatBug fixes, a calmer view, and each helper's whole conversation.

Time limit in your chatsNoneNo more "Timed out" or "deadline elapsed before admission".

Bots60 minutes per replyNobody is watching to press Stop there.

Where it opensSide panel + ExpandExpand shows it full size in place of the main chat.

Keep conversationsAs long as the chatDeleted with the chat, counted in Storage.

**Correction.** My earlier pages said clicking a helper in the chat card opens nothing today. That was wrong. Rows in the chat card, and "Open in side panel" in the pill's tray, already open the side panel, but they land on the inspector. Once the helper chat exists, those same clicks land on it. So the old PR 4 isn't needed, and its one leftover piece (a button rename) moves into PR 3. The before-and-after page is fixed too.

**One question.** Aiden's safety grant for a helper can't be longer than 24 hours, and 86 places in the code check it. Which way?

1. Treat "no limit" as a 24-hour safety net nobody will reach in a chat. This is small and safe (recommended).
2. Truly no limit. That means reworking the safety grant everywhere it's checked, which is a bigger and riskier PR 1.

The plan below assumes a. Bots keep 60 minutes either way.

PR 1

## Fix the bugs and change the time limits

Mostly behind the scenes

#### What you'll notice

- The task text shows in full again, even with a `JSON:` block in it.
- Helpers in your chats keep going until they finish, fail or you press Stop.
- When a helper is stopped or fails, the main chat gets its last message and the files it changed, so it can't say "no subagent ran" when one did.
- Result no longer repeats the warning, and a stuck helper has Stop right in its "No recent update" notice.

#### Build steps

1. ### Fix the privacy filter

   `renderer/shared/subagent-safe-text.ts`
   - `indentedEnvironmentValueEnd`: stop at the line break before the next unindented line instead of moving past it. Today it swallows that line break, so a second pass gives different text and the whole task is hidden.
   - `redactEnvironmentAssignments`: a colon-and-block counts as a label when its name is all capital letters, like `JSON:`, `HTML:`, `NOTE:`, `TASK:` or `DATA:`, and has no secret hint. A secret hint is a setting-shaped name (all caps, snake or kebab case, or camelCase) ending in `key`, `token`, `secret`, `password`, `passphrase`, `pwd`, `jwt`, `cred`, `credential` or `cookie`; a plain word that is exactly one of those words, such as `Password:`, so prose headings like `Keys:`, `Hotkeys:` and `Design tokens:` survive; one of a few whole names (`AUTHORIZATION`, `SESSION_ID`, `SESSION_TOKEN`, `PRIVATE_KEY`), or a whole-segment `PIN`. A label's block still hides when its value looks like a credential to the existing detectors or is one opaque token on its own. Names with underscores or digits, and names with a secret hint, still hide in the panel, so `PASSPHRASE:`, `KEY:`, `APITOKEN:`, `API_KEY:` and `apiToken:` stay hidden.
   - The helper text the main chat reads hides every indented line under a colon-and-block whose name carries a secret hint, not only the first one, so a multi-line `PASSWORD:` block and its partial findings stay hidden there too. A prose heading such as `Authentication:` or `Keyboard:` is not a secret name, so its block survives. Main-chat compaction keeps its existing filter unchanged.
   - `sanitizeWithPolicyFacts`: before giving up and swapping the whole text for a marker, run the filter again until the text stops changing (at most 3 passes). Use the "\[REDACTED ENCODED TEXT\]" marker only when encoded data really triggered it.
2. ### Change the time limits

   `main/services/subagents/subagent-child-policy.ts`, `subagent-supervisor-core.ts`, `subagent-child-runner.ts`, `main/services/llm-client.ts`, `main/services/bot-runtime/bot-tool-sources-main.ts`, `packages/cli/src/bot-subagents.ts`
   - Two named limits replace the shared 10 minutes: **chat** (24-hour safety net, from the question above) and **Bot** (60 minutes).
   - Each place that creates helpers passes its limit. Your chats in `llm-client.ts` use chat. A Bot chat there, the Bot runtime in `bot-tool-sources-main.ts`, and the CLI's Bot helpers in `bot-subagents.ts` use Bot. Scheduled tasks can't start helpers today (they need a chat turn), so nothing changes for them.
   - The reply's clock starts at the first helper launch, not when the main chat starts answering. For Bots that gives the helpers the full 60 minutes. Every helper call in one Bot reply shares that clock. The desktop rebuilds a Bot's tools for every task phase, so it keeps the clock per execution claim (one admitted message and its reply) and drops it when that reply ends (even with the next message starting at once), is dismissed or is resumed by a person (a quiet automatic retry keeps the clock). `aiden serve` keeps it per turn. A new message starts a new reply with a fresh 60 minutes; in `aiden serve` that includes a follow-up sent while a reply is running. An interrupted Bot task that a person resumes counts as a new reply: carrying the old start across a restart would need it saved with the task.
   - A helper waiting for a free slot (only 2 run at once) no longer loses time while it waits in chats.
   - The "save one last turn for a report" step before the deadline only happens when a real limit applies, which means Bots.
3. ### Stop the refused-retry loop (Bots)

   `subagent-supervisor-core.ts` around the "elapsed before run admission" check
   - When a Bot's 60 minutes run out, the next helper call gets one plain tool result instead of an error: "Helpers can't start again in this reply because the 60-minute limit for Bot replies was reached. Finish the work yourself or tell the person." Later calls in the same reply get the same answer without running anything.
4. ### Hand over partial work when a helper is stopped or fails

   `subagent-child-runner.ts` (result paths for interrupted, failed and timed-out helpers), `subagent-workspace-write.ts`, `subagent-supervisor-core.ts` (`formatResults`), `subagent-event-projector.ts`
   - The turn-limit path already passes the helper's partial findings to the main chat (`sanitizePartialFindingsForParent`). Use the same path when you stop a helper, when it fails, and at a Bot's 60-minute limit. The result is marked "incomplete, unverified".
   - Record the relative path of each file the helper changes through Aiden's edit tools. The result lists up to 20 of them under "Files it changed:", one path per line, since a name can itself contain a comma or "and". If a write may still have been finishing when the helper stopped, the list says it may be incomplete. If the helper also ran commands, add: "It also ran commands, which may have changed other files."
   - The summary card the panel shows gets the same partial text, using the panel's stricter filter.
5. ### Remove duplicate and confusing text

   `subagent-event-projector.ts` (Result text), `renderer/components/subagent-detail.tsx`, `renderer/lib/subagent-view-state.ts`
   - The projector stops copying the warning into Result when there's no summary.
   - "Latest activity" is hidden once a helper has stopped.
   - The "No recent update" notice gets its own Stop button.
   - The new wording is "Stopped at the 60-minute limit for Bot replies". It replaces "The child tree reached its deadline" and "The child reached its deadline".
6. ### Write the plan into the repo

   `docs/plans/subagent-helper-chat-plan.md`, `docs/plans/README.md`
   - Add this plan to the repo's plan index, as the project's own rules require, so later work can find it.

#### Tests

- A realistic implementer task with a `JSON:` block shows in full in the saved panel view. A real `API_KEY:` block is still hidden.
- Filtering any text twice gives the same result. This runs over the existing sample texts, not a copy of the filter's own rules.
- With a fake clock, a third, queued helper still runs to the end after the first two take 15 minutes.
- A Bot reply's helpers stop at 60 minutes, and a later call in that reply gets the plain "can't start again" result without starting anything.
- Stopping a helper that edited a file gives the main chat its last message and "Files it changed: …".
- A panel render of a stopped helper shows no duplicate Result.

Suites: `npm run test:subagents` and the subagent panel and renderer tests (`subagents-panel.test.tsx`, `subagent-event-projector.test.ts`). Type check and lint.

#### Done when

- Your screenshot's helper shows its real task, shows no duplicates, and reports its edit to the main chat.
- No chat helper stops on time.
- CI is green on the final commit.
- The README's Native Subagents lines about time limits, and the project notes (`.memory/subagent-*.md`), are updated.

#### Phones

No change to what phones receive. They already know the "Stopped" and "Failed" states, and "Timed out" stays for old helpers and Bots. iOS and Android code is still checked because they read the same results.

PR 2

## Save each helper's conversation

Behind the scenesAfter PR 1

#### What you'll notice

Nothing yet. This PR records each helper's task, messages and steps while it runs and keeps them with the chat. PR 3 shows them.

#### Build steps

1. ### Define what a saved helper conversation is

   new `renderer/shared/subagent-transcript.ts`
   - Contents: the run it belongs to, a revision number, and a list of entries. The first entry is the task. After that, each message the helper wrote has its text and its steps.
   - Steps use the same `GenerationTimeline` format the main chat already uses. Read, Edited +18 −0, Ran a command and similar rows then look exactly like the main chat's.
   - A "trimmed" flag says older steps were dropped to stay under the size cap.
   - A strict parser rejects anything malformed, like the other shared formats.
2. ### Record it while the helper runs

   new `main/services/subagents/subagent-transcript-recorder.ts`; hooked into `subagent-child-runner.ts` where it already subscribes to the helper's events
   - Feed the helper's events into `GenerationTimelineProjector`, the main chat's step builder, plus a text collector.
   - Send at most about 4 live updates a second, and always send the final state.
   - Text and every step field (label, target, detail) go through the parent/helper credential filter, the one Phase 1 uses for a stopped helper's partial work: API keys, tokens, private key blocks and secret-named values (`PASSWORD:`, `OTP: 731905`, `PIN=4821`, a `SEED:` phrase) are hidden, and file paths are kept. A secret value that wraps onto the next line is hidden there too, and so is a recovery phrase of 12 or more lowercase words under a secret-shaped name. Ordinary prose and settings such as `OTP: sent by SMS`, `seed=1234` or `signature: "sha256"` stay readable. It does not use the panel's stricter summary filter, because this is the helper's actual work. While a message streams, its unfinished last word and any open `-----BEGIN` block are held back until they settle.
   - Each revision is saved before it is streamed. A failed save streams nothing and is retried with backoff; the final save is retried a bounded number of times. One save runs at a time. A store that keeps failing is reported once, and after 5 failures in a row it is left alone until something changes.
   - Edits show their line counts (+N −M), as in the main chat.
   - Helpers running in the separate model process (`subagent-inference-process`) report through the same event stream, so this covers them too.
3. ### Keep it with the chat

   `main/services/subagents/subagent-run-store-v2-core.ts`, `subagent-run-store-io.ts`, `subagent-run-store-production.ts`
   - One transcript file per helper, beside its existing record in the `subagent-runs-v2` folder. Writes are atomic, like the rest of that store.
   - The cap is 2 MB per helper. Older steps are dropped first, and the trimmed flag is set so the view can say so.
   - The existing chat-delete path (`subagentRunStore.deleteChat`, with its restart-safe tombstones) removes these files too.
   - Settings → Storage already counts `subagent-runs-v2` under chat threads, so the files are counted automatically.
4. ### Let the panel read it, live and saved

   `main/handlers/subagents.ts`, `main/services/subagents/subagent-history-read-core.ts`, `main/services/llm-client.ts`, `renderer/lib/generation-stream.ts`, `renderer/lib/chat-terminal-sync.ts`, preload
   - Saved: extend the existing `subagents:get` read to return the transcript alongside the summary, only after it proves ownership: the request comes from an active app window, the run belongs to that chat and workspace, and the chat's history references the run, or the running turn still tracks it under the same chat, workspace and generation. Nothing yet ties a chat to one window, so any open app window can read a chat it names.
   - Live: a new `chat:subagent-transcript` stream message (run, revision, changed entries), sent the same way as `chat:subagents` today.
   - A late joiner, such as someone who opens the panel mid-run, reads the saved copy, then applies newer live revisions.
   - Live updates go only to the window running the chat. Another window that opens the helper chat re-reads the saved copy whenever the run's status or saved revision changes, including when it becomes terminal, so it follows the helper in steps rather than token by token.
5. ### Bots and the Aiden server
   - Bot helpers record the same way. The Bot runtime builds its own helper manager, and the recorder hooks in at the same point.
   - The CLI server (`aiden serve`) runs the same code, so it saves transcripts too. Phones don't receive them yet.

#### Tests

- A fake helper run (task, two tool calls, a final answer) saves, reloads and comes back with the same entries and steps.
- Live updates arrive in order, and a reader that joins mid-run ends up with the same final transcript.
- A key such as `sk-…` in the helper's text is hidden in the transcript, while a file path stays readable.
- A key in a tool's command or search is hidden in the step; a whole or cut-off private key block never reaches a save or the stream.
- A run that goes past 2 MB drops its oldest steps and sets the trimmed flag, and what was dropped stays dropped in later saves.
- A failed save streams nothing and is retried; a slow save keeps one save in flight; a store that keeps failing is reported once and then left alone until something changes.
- A cancelled or timed-out helper marks its unfinished tools cancelled, and the result is handed back without waiting for the final save, through the real supervisor.
- A tool the helper was refused shows as blocked, and a tool that ends while the helper is stopping shows as cancelled, as in the main chat.
- An edit's line counts reach its step, on the desktop and under `aiden serve`.
- Deleting a chat removes its helpers' transcripts, including after a crash mid-delete.
- The read refuses another chat's or workspace's run, and a run the chat's history does not reference.

Register any new test file in the matching `package.json` test script, as the repo rules require.

#### Done when

- A real helper run on a dev build leaves a transcript you can read back.
- Deleting the chat removes it.
- `docs/storage.md` and the README mention it.
- CI is green.

PR 3

## The helper chat

What you seeAfter PR 2

#### What you'll notice

- Clicking a helper anywhere opens its chat in the side panel. That works from a row in the chat card, from the open action in the pill's tray (Open helper chat while it runs, Review when it waits on you, View result once it has ended), or from the Subagents list.
- The chat starts with the task, then shows every step, then the answer. It updates live while the helper runs.
- A bar at the bottom has the model, Stop, Expand and Close (Back when expanded). Expand shows the helper's chat full size in place of the main chat.
- When something goes wrong, one plain box explains it and offers Ask the main chat to retry.

#### Build steps

1. ### Helper chat view

   new `renderer/components/subagent-helper-chat.tsx`
   - **Top:** a status dot, the helper's name, and one line such as "Implementer · Running · 3m 12s". Status words match the chat card: Queued, Running, Waiting on you, Done, Failed, Stopped.
   - **Body:** the task as a message bubble with its code block, then the helper's messages drawn with the main chat's own Markdown and step-row components (`Markdown`, `ActivityFeed`). They look identical and stay in step with future main-chat changes.
   - **Approvals:** the approval card in the main chat is the one place a helper's approval is answered. While the helper chat sits in the side panel, it shows a compact row, "Needs your approval in the main chat." (or "…, after 1 other request." / "after N other requests." when the main card shows others first; the header already says Waiting on you), with a Go to approval button (Go to main chat when others come first) that scrolls to the main card itself, focuses it and briefly tints it (no tint under Reduce Motion). The full card (the existing `subagent-workspace-write-approval.tsx`, `subagent-shell-approval.tsx`) shows inside the helper chat only while it is expanded, when the main card is out of view. A helper waiting on an approval reads "Waiting on you" in its rows, the pill and the tray, in the window running the chat, as a display-only overlay on its running record; the main chat's working line says the same words.
   - **Problem box:** soft colour fill, no border. "You stopped this helper after 2 steps. It changed cookbook.html." or the provider's error in plain words.
   - **Ask the main chat to retry** puts a ready-made message in the main composer and doesn't send it. For example: "Please retry the helper 'Add tweaks block to cookbook.html'. It stopped after 2 steps and changed cookbook.html."
   - **Trimmed note** at the top when PR 2 dropped old steps.
   - **⋯ menu, Technical details:** fresh start or copied chat, turns, tokens, where the model choice came from, and a copy button for the run ID.
   - Keeps scroll position, has a Jump to latest button, and announces status changes through the existing `SubagentLiveAnnouncer`. It respects Reduce Motion.
2. ### Bottom bar
   - Shows the model and effort, for example "GLM 5.3 Flash · Max", then Stop (only while running; Stop all when the helper has active helpers under it), Expand, and Close (Back to main chat when expanded; the effort is left out when it is off).
   - Stop uses the existing helper control (`subagents:manage`), the same as the Stop button today.
3. ### Expand to full size

   `renderer/components/environment-panel.tsx`, the chat pane
   - The panel state gets an "expanded helper". While it is set, the chat pane shows the helper chat where the main messages normally are, with the composer hidden and the same bottom bar.
   - Back to main chat or Esc (the Back tooltip reads "Back to main chat (Esc)") returns, and focus goes back to the button that opened it, or, if that button is gone, to the same helper's Expand button or the message box. While the helper chat covers the conversation, the conversation's hover cards and tooltips stay closed; a popover or dialog opened from it is a surface of its own. When the narrow side panel floats over the conversation, its open hover cards and tooltips close once, and the visible strip shows them again. Switching chats closes it.
   - The side panel shows only “<label>” is open in the main chat, with no button; the expanded chat's own Back to main chat is the only Back.
   - If the main chat waits on something else meanwhile, a note-style bar (warning fill, no border, announced once politely) says "The main chat needs your approval." or "The main chat has a question for you." Its button, Go to approval or Answer question, returns to the main chat and focuses the approval card or the questionnaire.
4. ### Calmer fallback for older helpers

   `renderer/components/subagent-detail.tsx`
   - Helpers saved before PR 2 have no transcript, so they keep a cleaned-up summary. "Task preview" becomes "What it was asked". The step list becomes "What it did", with plain step names such as "Read a file", "Changed a file" and "Wrote its report". Result stays.
   - Removed: Saved view notice, "Context: …", "Latest activity" on stopped helpers, and "activity milestones".
5. ### Wire up the existing clicks

   `renderer/components/subagents-panel.tsx`, `subagent-composer-pill.tsx`, `subagent-chips.tsx`
   - The Subagents panel shows the helper chat when a run has a transcript, and the fallback when it doesn't. The chat card rows and the tray already call `openSubagent`, so they need no new wiring.
   - The tray button "Open in side panel" is replaced by a state-worded open action: "Open helper chat" while the helper runs, "Review" when it waits on you, and "View result" once it has ended. The list rows use the same status words as the card.
6. ### Design rules
   - Follow `GUI.md`, `docs/design-guide.md` and the ChatGPT reference files the repo requires before new UI.
   - Use Aiden's tokens only. Status shows in soft fills, never in coloured borders. Keyboard focus rings stay visible.
   - No new icons beyond the existing set.

#### Tests

- Render tests: a running helper shows the task, its steps and Stop; a stopped one shows the problem box and no Stop; an older helper shows the fallback with no "Saved view notice".
- Ask the main chat to retry fills the composer and doesn't send.
- Expand, then Back or Esc, returns focus to the button that opened it.
- A new Playwright test clicks a helper row in the chat card and sees its chat open in the side panel. This also closes the pill PR's missing end-to-end test.

#### Screenshots before merge (light and dark)

- Running, Waiting on you (approval inside), Done, Failed, Stopped
- An older helper (fallback)
- Expanded full size
- A narrow window
- The tray with Open helper chat

#### Done when

- You've approved the screenshots.
- CI is green.
- The README is updated, and the onboarding "Native Subagents" tile is updated if its art shows the inspector.

## Limits after this plan

Removing the clock doesn't remove every limit, so a confused helper still can't run up an unbounded bill.

| Limit | Today | After |
| --- | --- | --- |
| Time, helpers in your chats | 10 minutes, shared by the whole reply | None (24-hour safety net) |
| Time, Bot helpers | 10 minutes, shared by the whole reply | 60 minutes, from the first launch |
| Steps per helper | 24 (up to 128 for read-only scouts) | Same |
| Tool calls per helper | 64 | Same |
| Helpers at once | 2 (1 on a local model), the rest wait | Same, and waiting costs no time in chats |
| Helpers per request | Up to 4 | Same |
| Spending and usage limits | Apply | Same |

A saved helper conversation differs from the main chat in a few small ways:

- MCP tools show their generic label, not the server-specific one.
- Each message's text is recorded on its own, so its text anchors always start at 0. This matches what the main chat computes for the same message.
- Thinking text is not saved, so thinking segments are not reconciled at the end of a message.
- When a chat reply finishes, the main chat waits at most 250 ms for its helpers' final saves. A slower save finishes in the background. Quitting Aiden waits up to 1 second more for any save still in progress.
- The filter that hides credentials in a helper's words is a best-effort heuristic, as it is for a stopped helper's handed-back work. It hides private keys, secret-named values, recovery phrases and codes (on one line, indented or not, numbered, or split across lines), and the wrapped rest of a hidden value. It can't catch every layout. For example, a secret wrapped onto a line that reads as a capitalised word, like `Done.`, is kept, so that ordinary text after a hidden value stays readable.
- Filtering is per message, so a secret split across two messages is not caught.

## Rules for every PR

- Branch from the latest main, run the narrow test suites locally first, and treat a PR as ready only when CI is green on its last commit.
- After each PR, a separate review pass checks for bugs and edge cases before you're asked to merge.
- Docs change in the same PR as the behaviour: README, the matching `docs/` page, `docs/plans/README.md` and the project notes.
- Tests check what you'd see or what the main chat receives, not the wording of the source code.
- Nothing in this plan changes what phones receive, so no Remote revision is claimed. Showing a helper's chat on iPhone and Android is its own later PR.
- Telegram is untouched.

## Risks and how each is handled

| Risk | What could happen | Handling |
| --- | --- | --- |
| Longer waits | With no clock, the main chat waits as long as its slowest helper. | The pill and "No recent update" show it, Stop is one click away, and the 24-hour net stays. |
| Showing more text | Today's panel shows little on purpose. The helper chat shows what the helper did. | The parent/helper credential filter (the one Phase 1 uses for a stopped helper's partial work) hides API keys, tokens, private key blocks and secret-named values in the text and in every step field. A dedicated security review comes before PR 2 merges. |
| Disk use | Many long helpers add up. | 2 MB cap per helper, deleted with the chat, and shown in Settings → Storage. |
| Overlap with "Make Aiden more proactive" | Its background helpers touch the same code. | That thread knows this plan. Its helper PRs build on these three, which give them a place to show their work. |
| Privacy filter change | Loosening the label rule could let a real secret through. | A name counts as a label only when it is a bare all-capital word of letters (no digits, `_` or `-`) with no secret hint, and a label's block still hides when its value looks like a credential. The secret-ending match (`key`, `token`, `secret`, `password` and the rest) applies only to setting-shaped names: all caps, containing `_` or `-`, or camelCase. Every all-caps name is setting-shaped, so `KEY:`, `APITOKEN:` and `PASSPHRASE:` never count as labels. Other names, such as prose headings, are hints only when they are exactly a secret word (`Password:`, `Credentials:`), so `Keys:` and `Design tokens:` survive; the secret words include `passcode`, `otp`, `totp`, `cvv`, `seed`, `mnemonic`, `private` and `signature` as well; a few whole names (`AUTHORIZATION`, `SESSION_ID`, `SESSION_TOKEN`, `PRIVATE_KEY`) and a whole-segment `PIN` are always hints (`colonBlockNameIsLabel` and `blockNameHasSecretHint` in `renderer/shared/subagent-safe-text.ts`). Every other name still hides in the panel, secret-named blocks hide on every line for the main chat, and tests cover both, including `PASSPHRASE:`, `KEY:`, `APITOKEN:` and multi-line `PASSWORD:`. The saved helper conversation also hides a secret-named value on the same line (`OTP: 731905`, `PIN=4821`, `"cvv": "381"`); references, paths, placeholders and prose such as `Signature: see the docs` stay, and `NOTE:`, `README:`, `Design tokens:` and `Keys:` survive. |

## Order

1. Now**PR 1** once you say go. It can merge on its own.
2. After PR 1**PR 2** builds on PR 1's result changes.
3. After PR 2**PR 3**, with screenshots sent to you before merge.
4. LaterHelper chat on iPhone and Android (a new Remote revision), if you want it.

Code references are from main at commit 1afb737c on 22 Nov 2026. File names may shift a little as other work lands.
