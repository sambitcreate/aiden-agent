# Subagent helper chat (give every helper its own chat, with no time limit)

Written 2026-11-22 from main at `1afb737c`. Built as one PR in three reviewed phases (the "PR 1/2/3" sections below are those phases).

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
   - `redactEnvironmentAssignments`: a bare all-caps word followed by a colon and an indented block, like `JSON:`, `HTML:`, `NOTE:` or `TASK:`, is a label, not a setting. Treat a colon-and-block as a secret only when the name looks like a real setting: it has an underscore or digit (`API_KEY:`, `AWS_SECRET:`) or matches the existing sensitive-name list.
   - `sanitizeWithPolicyFacts`: before giving up and swapping the whole text for a marker, run the filter again until the text stops changing (at most 3 passes). Use the "\[REDACTED ENCODED TEXT\]" marker only when encoded data really triggered it.
2. ### Change the time limits

   `main/services/subagents/subagent-child-policy.ts`, `subagent-supervisor-core.ts`, `subagent-child-runner.ts`, `main/services/llm-client.ts`, `main/services/bot-runtime/bot-tool-sources-main.ts`, `packages/cli/src/bot-subagents.ts`
   - Two named limits replace the shared 10 minutes: **chat** (24-hour safety net, from the question above) and **Bot** (60 minutes).
   - Each place that creates helpers passes its limit. Your chats in `llm-client.ts` use chat. A Bot chat there, the Bot runtime in `bot-tool-sources-main.ts`, and the CLI's Bot helpers in `bot-subagents.ts` use Bot. Scheduled tasks can't start helpers today (they need a chat turn), so nothing changes for them.
   - The reply's clock starts at the first helper launch, not when the main chat starts answering. For Bots that gives the helpers the full 60 minutes.
   - A helper waiting for a free slot (only 2 run at once) no longer loses time while it waits in chats.
   - The "save one last turn for a report" step before the deadline only happens when a real limit applies, which means Bots.
3. ### Stop the refused-retry loop (Bots)

   `subagent-supervisor-core.ts` around the "elapsed before run admission" check
   - When a Bot's 60 minutes run out, the next helper call gets one plain tool result instead of an error: "Helpers can't start again in this reply because the 60-minute limit for Bot replies was reached. Finish the work yourself or tell the person." Later calls in the same reply get the same answer without running anything.
4. ### Hand over partial work when a helper is stopped or fails

   `subagent-child-runner.ts` (result paths for interrupted, failed and timed-out helpers), `subagent-workspace-write.ts`, `subagent-supervisor-core.ts` (`formatResults`), `subagent-event-projector.ts`
   - The turn-limit path already passes the helper's partial findings to the main chat (`sanitizePartialFindingsForParent`). Use the same path when you stop a helper, when it fails, and at a Bot's 60-minute limit. The result is marked "incomplete, unverified".
   - Record the relative path of each file the helper changes through Aiden's edit tools. The result lists up to 20 of them: "Files it changed: cookbook.html". If the helper also ran commands, add: "It also ran commands, which may have changed other files."
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
   - Text goes through the main chat's display filter: passwords and keys are hidden, and file paths are kept. It does not use the panel's stricter summary filter, because this is the helper's actual work.
   - Helpers running in the separate model process (`subagent-inference-process`) report through the same event stream, so this covers them too.
3. ### Keep it with the chat

   `main/services/subagents/subagent-run-store-v2-core.ts`, `subagent-run-store-io.ts`, `subagent-run-store-production.ts`
   - One transcript file per helper, beside its existing record in the `subagent-runs-v2` folder. Writes are atomic, like the rest of that store.
   - The cap is 2 MB per helper. Older steps are dropped first, and the trimmed flag is set so the view can say so.
   - The existing chat-delete path (`subagentRunStore.deleteChat`, with its restart-safe tombstones) removes these files too.
   - Settings → Storage already counts `subagent-runs-v2` under chat threads, so the files are counted automatically.
4. ### Let the panel read it, live and saved

   `main/handlers/subagents.ts`, `main/services/subagents/subagent-history-read-core.ts`, `main/services/llm-client.ts`, `renderer/lib/generation-stream.ts`, `renderer/lib/chat-terminal-sync.ts`, preload
   - Saved: extend the existing `subagents:get` read, which checks that the chat belongs to this window, to return the transcript alongside the summary.
   - Live: a new `chat:subagent-transcript` stream message (run, revision, changed entries), sent the same way as `chat:subagents` today.
   - A late joiner, such as someone who opens the panel mid-run, reads the saved copy, then applies newer live revisions.
5. ### Bots and the Aiden server
   - Bot helpers record the same way. The Bot runtime builds its own helper manager, and the recorder hooks in at the same point.
   - The CLI server (`aiden serve`) runs the same code, so it saves transcripts too. Phones don't receive them yet.

#### Tests

- A fake helper run (task, two tool calls, a final answer) saves, reloads and comes back with the same entries and steps.
- Live updates arrive in order, and a reader that joins mid-run ends up with the same final transcript.
- A key such as `sk-…` in the helper's text is hidden in the transcript, while a file path stays readable.
- A run that goes past 2 MB drops its oldest steps and sets the trimmed flag.
- Deleting a chat removes its helpers' transcripts, including after a crash mid-delete.
- The read refuses a chat that belongs to another window.

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

- Clicking a helper anywhere opens its chat in the side panel. That works from a row in the chat card, from Open helper chat in the pill's tray, or from the Subagents list.
- The chat starts with the task, then shows every step, then the answer. It updates live while the helper runs.
- A bar at the bottom has the model, Stop, Expand and Back to main chat. Expand shows the helper's chat full size in place of the main chat.
- When something goes wrong, one plain box explains it and offers Ask main chat to retry.

#### Build steps

1. ### Helper chat view

   new `renderer/components/subagent-helper-chat.tsx`
   - **Top:** a status dot, the helper's name, and one line such as "Implementer · Running · 3m 12s". Status words match the chat card: Queued, Running, Waiting on you, Done, Failed, Stopped.
   - **Body:** the task as a message bubble with its code block, then the helper's messages drawn with the main chat's own Markdown and step-row components (`Markdown`, `ActivityFeed`). They look identical and stay in step with future main-chat changes.
   - **Approvals:** a helper's approval card shows inside its chat, using the existing approval components (`subagent-workspace-write-approval.tsx`, `subagent-shell-approval.tsx`).
   - **Problem box:** soft colour fill, no border. "You stopped this helper after 2 steps. It changed cookbook.html." or the provider's error in plain words.
   - **Ask main chat to retry** puts a ready-made message in the main composer and doesn't send it. For example: "Please retry the helper 'Add tweaks block to cookbook.html'. It stopped after 2 steps and changed cookbook.html."
   - **Trimmed note** at the top when PR 2 dropped old steps.
   - **⋯ menu, Technical details:** fresh start or copied chat, turns, tokens, where the model choice came from, and a copy button for the run ID.
   - Keeps scroll position, has a Jump to latest button, and announces status changes through the existing `SubagentLiveAnnouncer`. It respects Reduce Motion.
2. ### Bottom bar
   - Shows the model and effort, for example "GLM 5.3 Flash · Max", then Stop (only while running), Expand, and Back to main chat.
   - Stop uses the existing helper control (`subagents:manage`), the same as the Stop button today.
3. ### Expand to full size

   `renderer/components/environment-panel.tsx`, the chat pane
   - The panel state gets an "expanded helper". While it is set, the chat pane shows the helper chat where the main messages normally are, with the composer hidden and the same bottom bar.
   - Back to main chat or Esc returns, and focus goes back to the button that opened it. Switching chats closes it.
4. ### Calmer fallback for older helpers

   `renderer/components/subagent-detail.tsx`
   - Helpers saved before PR 2 have no transcript, so they keep a cleaned-up summary. "Task preview" becomes "What it was asked". The step list becomes "What it did", with plain step names such as "Read a file", "Changed a file" and "Wrote its report". Result stays.
   - Removed: Saved view notice, "Context: …", "Latest activity" on stopped helpers, and "activity milestones".
5. ### Wire up the existing clicks

   `renderer/components/subagents-panel.tsx`, `subagent-composer-pill.tsx`, `subagent-chips.tsx`
   - The Subagents panel shows the helper chat when a run has a transcript, and the fallback when it doesn't. The chat card rows and the tray already call `openSubagent`, so they need no new wiring.
   - The tray button is renamed from "Open in side panel" to "Open helper chat". The list rows use the same status words as the card.
6. ### Design rules
   - Follow `GUI.md`, `docs/design-guide.md` and the ChatGPT reference files the repo requires before new UI.
   - Use Aiden's tokens only. Status shows in soft fills, never in coloured borders. Keyboard focus rings stay visible.
   - No new icons beyond the existing set.

#### Tests

- Render tests: a running helper shows the task, its steps and Stop; a stopped one shows the problem box and no Stop; an older helper shows the fallback with no "Saved view notice".
- Ask main chat to retry fills the composer and doesn't send.
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
| Showing more text | Today's panel shows little on purpose. The helper chat shows what the helper did. | The main chat's own display filter hides passwords and keys, the same as for the main chat's steps. A dedicated security review comes before PR 2 merges. |
| Disk use | Many long helpers add up. | 2 MB cap per helper, deleted with the chat, and shown in Settings → Storage. |
| Overlap with "Make Aiden more proactive" | Its background helpers touch the same code. | That thread knows this plan. Its helper PRs build on these three, which give them a place to show their work. |
| Privacy filter change | Loosening the label rule could let a real secret through. | Only plain words without underscores or digits count as labels. Real setting names and known sensitive names still hide, and tests cover both. |

## Order

1. Now**PR 1** once you say go. It can merge on its own.
2. After PR 1**PR 2** builds on PR 1's result changes.
3. After PR 2**PR 3**, with screenshots sent to you before merge.
4. LaterHelper chat on iPhone and Android (a new Remote revision), if you want it.

Code references are from main at commit 1afb737c on 22 Nov 2026. File names may shift a little as other work lands.
