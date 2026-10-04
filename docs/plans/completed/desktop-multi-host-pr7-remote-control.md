# Multi-host PR 7: remote control

Status: **Complete**; merges with the multi-host stack. Row 7 of the [desktop multi-host control plan](desktop-multi-host-control-plan.md) (§5 Renderer). Stacked on PR 6 ([remote chat view](desktop-multi-host-pr6-remote-chat-view.md)).

PR 6 made a paired host's chat viewable. This PR makes it controllable from this Mac: send, stop, approvals, questions, steer and queue, rename and delete, through the same adapter interface the local pane now uses.

## Scope

- **Control interface.** `HostChatAdapter` gains `send`, `cancel`, `respondApproval`, `answerQuestion`, `submitInput`, `rename` and `remove`. Control methods reject with a `HostChatControlError` that carries the host code, the winning decision of an approval race and any reconciled state. The local pane's existing try/catch and toast paths therefore work unchanged.
- **Local adapter** (`renderer/lib/hosts/local-host-adapter.ts`). A thin wrapper over `chatsApi`, `startGeneration`, `stopDetachedGeneration`, `admitChatRunInput` and `aidenRemoteApi.respondApproval`. It has no behaviour of its own, so local keys, routes, stores and IPC are untouched.
- **`useChatSession(adapter, ref)`** (`renderer/lib/hosts/use-chat-session.ts`) over a framework-free `ChatSessionControl`. Every operation captures the host and chat at its start. The hook exposes `send`, `stop`, `decideApproval`, `answerQuestion`, `submitInput`, `rename` and `remove`, plus the reconciliation and "answered elsewhere" state. `ChatPane` routes its rename, stop, approval, question and steer calls through it with the local adapter. The remote pane uses the same hook with the remote adapter.
- **Shared prompt surfaces.** The approval card moves out of `chat-pane.tsx` into `renderer/components/chat-approval-card.tsx` with identical markup. The remote pane renders it, `AskUserQuestionComposer`, `MessageList` and the real `Composer`.
- **Remote adapter control.**
  - `send` maps to `POST /chats/{id}/turns` with a client-minted idempotency key.
  - `cancel` maps to `POST /runs/{runId}/cancel`, which also stops runs started on the host's own screen.
  - `respondApproval` and `answerQuestion` map to the `/runs/{runId}/approvals|questions/…/respond` routes. A `409 approval_resolved` or `question_already_resolved` becomes an "answered elsewhere" result carrying the winning decision.
  - `submitInput` maps to `POST /runs/{runId}/inputs` (`steer` or `queue`).
  - `rename` and `remove` use the host's chat revision.
  - Capabilities are derived from the host's grants and features: `chat:write` for send, rename and delete; `run-control-v1` plus `runs:control` for run control.
- **Composer gating.** `Composer` takes an optional `surfaces` prop, derived from adapter capabilities by a pure function. The defaults preserve the local composer exactly. A remote chat hides attachments (button, drop and paste), browser annotations, the workspace/Git/pull-request context bar, the permission control, computer use, the context meter, thinking control, compact, BTW, clone/fork/export and slash commands. Header actions that act on this Mac (open in editor, Environment, Quick View, terminal) are rendered only when the adapter has `localPanels`. Nothing falls back to a local call.
- **Host binding and fencing.**
  - An operation captures `hostId` and the supervisor generation when it starts.
  - A mutation answer that lands after the generation moved is reported as "outcome unknown" rather than applied or dropped silently.
  - Switching the selected chat never retargets in-flight work.
  - Mutations are refused while the host is offline or blocked, with the reason shown. There is no offline queue.
- **Lost acknowledgements.**
  - A send keeps its idempotency key until the host confirms it.
  - On `outcome_unknown` the composer is cleared and a reconciliation notice says the message may not have been sent. **Retry** resends with the same key, so the host returns the original turn instead of starting a second one. **Dismiss** forgets the intent.
  - Nothing is resent automatically.
  - Keyed intents live in a per-window ledger (`chat-intent-ledger.ts`) keyed by `{hostId, chatId}`, not in the pane. Leaving and reopening a chat keeps the notice and its key, and an answer that lands after the pane left is still recorded for the reopened chat.
- **Guidance.** A steer or queue that the host saved to the chat after its run ended (`committed` without `admitted`) clears the composer and says so. Only an uncommitted rejection restores the text.
- **Rename and delete.** Both are guarded by the chat's revision. After a rename, or after a rename or delete the host refused as stale or whose outcome is unknown, the open chat rereads its newest window. It never adopts a revision that may not match the messages it shows.
- **Shortened approvals.** The host bounds an approval summary to 2,000 characters. A summary it had to shorten marks the prompt `detailsOmitted`, so it can only be denied from another device.
- **Files and Git.** A remote chat has no Environment, Files or Git surface yet, so nothing there can act on another Mac. When those views arrive they are read-only for remote chats.
- **Drafts.** A remote chat's draft key is `hostResourceKey({hostId, resourceId: chatId})`, so it never collides with a local chat of the same ID. Local draft keys are unchanged.
- **Peer errors.** `PeerOperationError` passes through the host's sanitized `details` (decision, outcome, resolvedAt, currentRevision), so the renderer can name an approval race's winner. This is not a host contract change.
- **Translator.** A remote approval can be allowed when the host sent its exact details (`detailsOmitted` absent). The prompt keeps the details so the same specialized cards render.

## Decisions

- **Two shells, one session.** The local `ChatPane` keeps its local-only machinery: streaming through `startGeneration`, queued messages, BTW, compaction, workbench panels and first-message drafts. Both panes drive control through `useChatSession` and render the same message list, approval card, question composer and composer. The remote shell is the existing `RemoteChatPane`. Merging the two shells further would move hundreds of lines of local generation code without any change in behaviour.
- **Throw-based control, result-based reads.** Reads keep `HostChatResult` so the PR 6 session can tell fenced reads apart. Control methods throw, so the local pane's error handling stays as it is.
- **Attachments wait for PR 8.** Sending an attachment to a host needs the remote upload flow (`POST /attachments`). Text turns do not, so remote attachments ship with the PR 8 composer host picker.
- **Skills.** The skill palette lists this Mac's workspace skills, and the turn contract has no remote catalog wiring yet, so slash commands are hidden for remote chats. PR 8 can add the host catalog (`skills` operation) behind `chat-skills-v1`.
- **Models.** A remote send carries no provider or model, so the host uses the chat's own. The composer shows no model picker for a remote chat. Changing a remote chat's model is out of scope.
- **No contract changes.** Only PR 2 and PR 3 operations are used. iOS and Android are unaffected.

## Tests

- `main/services/peer-remote-chat-control.test.ts` wires the real PR 2 host run registry, run-control service and idempotency ledger, PR 3's peer manager and live IPC handlers, and the renderer adapter and session control in-process. The harness (`peer-remote-chat-test-host.ts`) is shared with the PR 6 view suite. It covers:
  - a lost send acknowledgement with a same-key retry, which produces one turn and one transcript message;
  - an answer that lands after the connection changed, which is fenced as outcome unknown and retried without a second turn;
  - stopping a run started on the host;
  - an approval race between two Macs, which resolves once and shows the loser the winner's decision;
  - question answering and steer;
  - leaving a chat whose send is unresolved, or still in flight, then reopening it: the text and key survive and the retry starts one turn;
  - a command approval too long to show in full, which can be denied but not allowed;
  - a rename followed by a delete, and a stale delete that rereads instead of overwriting;
  - an unreachable host refusing every mutation, with nothing sent once it is back;
  - the same `ChatSessionControl` driving a local chat (through `LocalHostAdapter`) and a remote one to the same outcome.
- `renderer/lib/hosts/chat-session-control.test.ts`: host binding, offline gating, reconciliation and retry with the same key, approval "elsewhere" notices.
- `renderer/lib/hosts/local-host-adapter.test.ts`: the local adapter delegates to the existing local APIs.
- `renderer/main/remote-chat-view.test.tsx`: composer and header gating, approval and question controls, offline disabled reasons and the reconciliation notice, all through `renderToStaticMarkup`, plus guidance the host saved after its run ended.
