# Design mode v2 — Phase 1b: workspace canvas chat pages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each chat its own page on the shared workspace canvas.
- Main writes `chatPages[chatId]` when a chat enters design mode, on its first canvas write without one, and when Aiden picks another page.
- A page made for a chat follows the chat's title.
- Deleting a page moves its chats to the page the delete leaves first.
- Deleting a chat takes its claim and its artifact frames off the canvas.

**Architecture:** `chatPages` belongs to main.
- **One module.** Every write to it is a pure helper in a new shared module, `renderer/shared/design-canvas/chat-pages.ts`, called inside `store.update` on the latest document. So two chats' writes never race.
- **Saves.** A person's save from the renderer never adds or moves a claim. The store merges claims from the stored document. It takes the renderer's entry only for a page that save brings back, and only within what the store recorded when the page was deleted. It returns the merged claims, so the saving canvas shows what was stored.
- **View and claim.** The chat's view (`DesignCanvasViews`, 1a) stays the page the canvas shows. The claim is the chat's home page, used when the view's page is gone or the chat has no view. A claim always shows its page, so view and claim agree when the claim is made. After that the person can look anywhere.

**Tech Stack:** TypeScript (ESM), Electron 43 main, React 19 renderer, `tsx --test` for unit tests, Playwright E2E through `npm run test:e2e:space`.

**Spec:** `docs/superpowers/specs/2026-11-23-design-mode-live-app-design.md` §6.1 ("A chat's page", "Sharing in practice"), §8 (row 1b), §12. Stacked on PR #894 (Phase 1a, plan `docs/superpowers/plans/2026-11-23-design-mode-v2-p1a-workspace-canvas.md`).

## Scope

In scope:
- the page claim on design-mode entry, with a page made for the chat named after it and renamed with it until someone renames it by hand;
- a lazy claim on a chat's first canvas write in a design turn while it has no claim;
- `canvas_page {action: "use", page}`;
- page delete reassigns its chats, and `canvas_page delete` refuses a page another chat uses unless `force: true`;
- the `chatPages` fallback in page resolution (the A12 handoff note), in the same order on main and the renderer;
- undo that keeps a deleted page's place when another writer changed the page list (a 1a bug, fixed here because claims depend on it);
- lifecycle:
  - chat delete, live and in startup recovery, prunes its `chatPages` entry and its artifact frames;
  - moving an empty chat drops its entry and an empty page made for it;
  - an attached No workspace chat claims its first carried page;
- the page picker shows how many chats use each page (§6.1 "Sharing in practice");
- the two-chats E2E.

Out of scope:
- any live-app, app-server or DESIGN.md work (2a onward);
- a person-facing "use this page for this chat" action. Only entry, the lazy claim and Aiden's `canvas_page use` claim. The picker only shows claims;
- naming other chats in tool answers or the picker. Both give counts only, never another chat's title or id. Page names may still carry a chat's title by design, since a page made for a chat is named after it (D6);
- Remote and phones. `chatPages` stays out of the Remote projection, and phone turns never get canvas tools (`designTurnEligible` requires `localRenderer`, `canvas-tools.ts:167`). The iOS and Android clients don't change;
- analytics events. 1b adds none.

## What 1a already does (checked against the code at `19d79bbb7`)

| Item | 1a state | 1b action |
|---|---|---|
| `chatPages` in the schema | Parsed; entries kept only for safe chat ids naming existing pages (`schema.ts:377`). Nothing writes it. | Add the writers, `DesignPage.namedFor` and an explicit 2 000-entry cap. |
| `deletePage` | Drops `chatPages` entries for the deleted page (`pages.ts:84`). | Reassign them to the first page left. |
| `changesBetween` (undo carry) | Takes `to.pages` whole when the outline changed (`canvas-history-core.ts:119-125`). An undo that restores a deleted page loses it when another writer also changed the page list. Claims are kept from the step, not carried. | Apply page changes item by item, and carry claim changes (Task 1). |
| `viewPageId` | View page, else first page (`view.ts:28`). Frames and comment inputs also call it, so it isn't chat-aware. | Leave it. Add `chatPageId(doc, view, chatId)`. |
| `designTurnPages` resolver | Shown this turn → message page → kept view page → first page (`views.ts:283`). | Insert `doc.chatPages[chatId]` before the first page. |
| Renderer shown page (`use-design-view.ts:61` `shownPageId`) | View page → newest earlier page → first page. | View page → claim → newest earlier page → first page, and report when the fallback differs from the view. |
| `DesignCanvasViews` | `showPage` mints a `focusId`. Views persist per workspace. `forget` runs on chat delete. | Add `pageIdsOf(workspaceId, exceptChatId)` for entry rule 3. Claims show their page through `showPage`. |
| Entry (`written-pages.ts:362` `entryPlacement`, A21) | `entry: { pageName, hasView }`. Returns early when the chat wrote no pages, so nothing is claimed. | The claim rules in D2. Drop `hasView`. Claim even with no written pages. |
| Entry vs consent | `setDesignMode` starts entry with `void` (`chat-application-service.ts:407`). The consent card's `enter` (`design-canvas-main.ts:41`) awaits only `setDesignMode`, so the tool answers "entered" before entry has claimed. | The consent path awaits entry (Task 6). |
| `canvas_page` tool | add, rename, duplicate, delete (`force` covers the person's or locked frames), move, show (`canvas-tools.ts:1655`). | Add `use`. One refusal for delete. Mark the chat's page in `pagesAnswer`. |
| `forgetChat` (`cleanup.ts`) | Drops the chat's comments and view. The live delete runs it before and after the commit (`chat-application-service.ts:840,857`). Startup recovery runs it once, before `chatStore.remove` (`main/index.ts:2604`). | A required `scope`. The claim, `namedFor` and artifact frames go after the remove commits, in both paths. |
| Title changes | `rename`, `replaceTitleIfUnchanged`, `replaceAutoTitle` and the first-message seed in `appendMessage` (`chat-store-core.ts:1933,1972,2449,2317`). No listener. | `onTitleChanged`, fired after the write resolves, outside the chat lock (Task 4). |
| Workspace remove | Deletes the canvas, its corrupt copies and the views file (`workspace-application-service.ts:543`). | None. |
| Managed-worktree delete, create rollback, startup recovery | Go through the worktree service's `removeWorkspace`, wired to `removeDesignCanvasWorkspace` (`workspace-worktree-application-service-main.ts:143`, `main/index.ts:2749`). Covered by `workspace-worktree-application-service.test.ts` (from line 18, rollback cases near 174 and 814). | Confirm only (Task 9). |
| Attach carry (`carry.ts`) | Appends pages and calls `showPage(firstPage)`. Doesn't copy `chatPages`. | Claim the first carried page in the same update. |

## Global Constraints

- **Schema.** No version bump. `version: 3` gains one optional page field, `namedFor?: string`, a safe chat id (`isDesignChatId`). Pre-1.0, no migration: a 1a document has `chatPages: {}` and no `namedFor`, and both read fine.
- **Cap.** `chatPages` holds at most 2 000 entries. `claimPage` enforces it explicitly: it evicts entries of chats that no longer exist first, and otherwise throws `ChatPagesFullError` (`"This canvas has too many chats with pages of their own."`). `mergeSavedChatPages` never adds entries (D3), so it has no cap check and never refuses a person's save. Parse has no cap today (`schema.ts:377-382`); 1b makes it drop entries past 2 000 and count them in `dropped`, as it does for frames, so a hand-edited file is never set aside whole. Every caller of `claimPage` that is part of a larger write (the lazy claim, attach carry) catches `ChatPagesFullError` and skips only the claim.
- **Where claims are written.** Every claim read and write happens inside `store.update`'s mutate on the latest document. Main's checks that need I/O (which chats still exist, other chats' kept views) run before the update. A claim that appears after the check counts as a live chat's.
- **Saves.** A person's save (`DesignCanvasStore.save`) never adds or moves a claim on its own say, except to restore entries that the store recorded when the page was deleted (D3). The save's answer carries the merged claims back.
- **Undo.** Claim changes are never undo steps:
  - entry, the lazy claim inside a tool edit, title-follow and cleanup updates are carried into every kept step;
  - the save merge keeps a `canvas_page use` claim when the person undoes that turn (D3).
- **Naming other chats.** Tool answers and picker labels name other chats only by count, never by title or id. A page made for a chat carries the chat's title as its name; that is intended.
- **AGENTS.md:**
  - no source-grep tests;
  - new test files are registered in `scripts/ci-test-registry.json` and in `test:design-mode` in `package.json`, then `npm run test:ci-policy` is run;
  - docs change in this PR;
  - window-opening E2E runs through `npm run test:e2e:space`;
  - the picker change needs before and after screenshots in the PR body.
- **Tests.** A test that can't fail before its task's change is marked **(guard)** and kept only where it pins a rule a later change could break.

## Data rules

**D1. Who may claim.** Only main, and only for the acting chat:
- design-mode entry, for the chat entering (Task 6);
- the lazy claim, for the chat whose design turn writes the canvas (Task 8);
- `canvas_page use`, for the chat whose turn calls it. It sets `chatPages[deps.chatId]` only (Task 7);
- attach carry, for the attaching chat (Task 9).

No chat ever sets another chat's entry. Other chats' entries change only by:
- page delete, which reassigns them (D4);
- chat delete or move, which drops the leaving chat's own entry (Task 9).

The renderer never writes a claim beyond what the store's merge allows (D3). Bot chats can't have design mode, so they never claim. Several chats may share a page.

**D2. Claim on entry.** When design mode turns on, `placeWrittenPagesOnCanvas` with `entry` decides the chat's page in one update. Before the update, main reads:
- which claimed chats still exist (`chatStore.getMeta`);
- the other chats' kept view pages (`DesignCanvasViews.pageIdsOf(workspaceId, chatId)`).

Claims of chats that no longer exist count as absent. The rules, in order:
1. The chat already has a live claim (its entry names an existing page). Keep it. Missing written pages go there; pages already on the canvas are not placed again. No new page.
2. Some of the chat's written pages are already on the canvas. Claim the page holding the most of them (on a tie: the resolved page, then the earliest page). Pages another live chat claims are not counted; when only such pages hold them, go on to rules 3 and 4. This is A21's rule, now written as a claim.
3. The resolved page (kept view page, else first page) is taken as it is, with no rename and no `namedFor`, when:
   - its `namedFor`, if any, names this chat;
   - and no other live chat claims it;
   - and either it holds no frames, or no other chat's kept view is on it.

   An empty page another chat claims is not shared: the second chat on a fresh canvas gets a page of its own (rule 4, spec §6.1).

   This covers the first chat on a fresh canvas, canvases seeded by tests, and a 1a canvas only this chat has looked at.
4. Otherwise, add a page right after the resolved page, named after the chat (D5), with `namedFor: chatId`, and claim it. At the 200-page limit, claim the resolved page (shared) instead.

After the update, main always calls `pages.show(workspaceId, pageId)`, so the view and the open canvas move to the claimed page. Then it runs the title follow for the chat once (D6), in case the title changed while entry ran. `entry.hasView` is gone. Rule 3's view check covers the race it guarded: a mounting canvas reports a view on another chat's page before entry runs.

**D3. Claims survive undo.** A person's save (the renderer sends a whole document; undo and redo are saves with `undone`) merges in the store with `mergeSavedChatPages(current, saved, deleted)`:
- Start from `current.chatPages`, the stored claims.
- `deleted` is the store's in-memory record, per workspace, of pages removed by any write (save or update) that had claims or a `namedFor`: `pageId → { namedFor?: string; claims: Map<chatId, movedTo> }`. It holds at most 200 such pages per workspace, and the oldest go first. Main and the renderer restart together, so a record lost on restart matches an undo history lost on restart.
  - The record changes only after the write succeeded (`beforeWrite` can throw, `store.ts:130`, `store.ts:157`).
  - A new delete of the same page id replaces its entry; it never merges into the old one.
  - A restore removes the restored chats (and the restored `namedFor`) from the entry, and drops the entry once it is empty. So a redo after an undo, and the same page id deleted twice, each act on the newest delete only.
- For a page the save brings back (in `saved`, not in `current`), take the saved entry `C → P` only when `deleted` records C on P and `current[C]` is exactly the page that delete moved C to. A chat that is missing from `current` is never brought back: a live chat of this workspace always has its entry (only dead chats are evicted), so a missing entry means C was deleted or moved away. The merge therefore never adds an entry, so it never hits the cap and never refuses a person's save.
- Every resulting entry whose page is not in `saved` is reassigned to `saved.pages[0]` (the save deleted that page), and recorded in `deleted`.
- `namedFor`: a saved page keeps it only when `current`'s page with that id has the same value, or when the page is brought back and its `deleted` entry holds that `namedFor` for a chat that is still live in this workspace. A save can always drop it, as a hand rename does.
- "Live" everywhere in 1b (`isLive`) means the chat's metadata exists **and** its `workspaceId` is this canvas's workspace. A chat that moved away is not live here.

The answer to a save the merge changed (`{ ok: true, revision, chatPages, namedFor }`, Task 2) gives the stored claims and each page's `namedFor`. The renderer applies them to `server` and `local`, and carries them into kept steps as a non-undo change.

So:
- undoing an unrelated edit, or an Aiden turn that called `canvas_page use`, never loses or moves a claim, and the picker keeps showing the stored claim;
- undoing a page delete brings the page back with its claims, unless a chat has claimed elsewhere since;
- a renderer can't move a claim onto a page id the store never saw claimed.

**D4. Page delete.** `deletePage` reassigns every entry naming the deleted page to the first page left, whoever deletes:
- the person in the picker (shared `deletePage` in the renderer, then the store's merge);
- Aiden through `canvas_page delete`;
- entry's retraction, which instead removes the chat's claim on the page it added.

`canvas_page delete` without `force` checks two things on the latest document:
- the person's or locked frames on the page;
- other live chats' claims on it.

If either applies, it refuses once, naming what applies. For example: `"That page holds 2 frames the person added or locked and is the page of 1 other chat. Delete it only if the person asked, and then pass force: true."` Counts are pluralised: "1 frame" / "N frames", "1 other chat" / "N other chats". Deleting the acting chat's own page needs no `force` for its claim. The person's picker delete is not refused (it already has an Undo toast).

A chat whose page another chat deleted reads, in order: its view page, which is gone; its claim, now the first page; the first page. It doesn't get a new page on its next entry, because its claim is live (D2 rule 1).

Undoing chat A's turn that added page Q, after chat B started using Q, removes Q (the save brings nothing back) and reassigns B to the first page.

**D5. Names.** A page made for a chat is named `uniquePageName(doc, title)`:
- whitespace is collapsed and the name is cut to 60 characters;
- an empty title gives `"Chat"`;
- when another page already has that name (case-insensitive), the name gets `" 2"`, `" 3"` and so on, with the base cut so the suffix fits.

So `canvas_page`'s by-name lookup stays unambiguous for pages Aiden names. Pages the person names may still repeat; that is unchanged.

**D6. Rename with the chat.**
- **What follows.** A page with `namedFor: chatId` takes the chat's current title (through D5, ignoring its own name).
- **When.** After any title change, which covers four writers:
  - `rename` (sidebar, title bar, phone);
  - `replaceTitleIfUnchanged`;
  - `replaceAutoTitle`, which usually lands after entry, so the page goes from "New chat" to the real title;
  - the first-message seed in `appendMessage`.
- **How.** `follow(chatId)` ignores the event's title.
  - It runs in a per-chat serial queue.
  - When its turn comes, it reads `chatStore.getMeta(chatId).title` and writes through `DesignChatCanvases`, so the workspace-exists `beforeWrite` applies.
  - It writes only when a page follows the chat and its name would change.
  - Listeners fire after the title write resolves, outside the chat lock.
  - Entry's late check calls the same `follow`, so two quick renames and an entry running together end on the newest title.
- **What stops it.**
  - `renamePage` (the picker's Rename and Aiden's `canvas_page rename`) clears `namedFor`.
  - Chat delete clears it; moving the chat clears it or deletes the page (Task 9).
  - `duplicatePage` and `appendCanvasPages` never copy it.
- **Brought back.** A page an undo brings back keeps `namedFor` only for a chat that is live in this workspace: `DesignChatCanvases.save` asks `chatIsLive` for the chats the saved pages are named for before it waits on the store's chain, and passes the answer to the merge.
- **Not the claim.** It follows `namedFor`, not the claim, so a chat that used another page still renames the page made for it.

**D7. View page versus claimed page.**
- Resolution order:
  - main, through `designTurnPages`: a page Aiden showed this turn, the message's page, the chat's kept view page, `chatPages[chatId]`, then the first page;
  - the renderer, through `useDesignView`: the view page, the claim, the newest earlier page, then the first page;
  - on both sides each step counts only while its page exists, and the claim comes right after the view.
- When the renderer shows a fallback page different from `state.pageId`, it schedules a view report, so main's kept view matches what is on screen.
- The view is what the person looks at. Pans and page switches change it, never the claim.
- The claim changes only through D1 and D4. Claims call `showPage`, which mints a `focusId` (A18). A delete's reassignment shows nothing to other chats: their canvases fall through the order above.

**D8. Two chats' turns at once.** Every claim read and write happens inside one `store.update` mutate on the workspace's chain:
- `canvas_page use` checks that the page exists on the latest document;
- delete's checks and its reassignment, entry's rules and the lazy claim all run on the latest document.

So:
- chat A's `use P` racing chat B's `delete P` either fails with "There is no page named…" or lands and is then reassigned;
- two chats entering a fresh canvas at once end with the first on Page 1 (rule 3) and the second on a new named page (rule 4: Page 1 now holds the first chat's claim and view);
- a turn whose page was deleted mid-turn resolves to the claim on its next call;
- the consent path awaits entry, so Aiden's first placement after "entered" lands on the claimed page (Task 6).

**D9. Chats with no claim.** A chat can have no claim:
- it was in design mode when the app upgraded;
- it moved from another workspace;
- it attached without carried pages.

Its next entry claims by D2. Rule 3 checks other chats' views, so it doesn't take a page another chat is working on. If it writes the canvas in a design turn first, the lazy claim (Task 8) claims the page the write landed on, inside that write. Reads and canvas mounts never claim. Attach carry claims the first carried page in its own update, without `namedFor` (carried pages are named "<title> · <page>"); a `ChatPagesFullError` there skips only the claim. The hidden canvas's own `chatPages` and `namedFor` never come over.

**D10. Legacy documents.** v1 and v2 files are gone (1a's layout wipe). A 1a v3 document has `chatPages: {}`. Its chats resolve as in 1a until they enter design mode again, write the canvas in a design turn, or call `canvas_page use`. Until then, `canvas_page delete` doesn't protect their page. No sweep runs at startup.

## Review Focus

1. **Undo never loses a claim or a page.** Undoing a page delete brings back the page and its claims even after another writer changed the page list, and the saving canvas shows the stored claims (D3, decisions 1–3). Tests: Tasks 1 and 2.
2. **Two chats enter one workspace and each gets its own page, with no page jumps when switching between them after entry** (D2, D7). Tests: Tasks 3, 6 and 11.
3. **A page another live chat uses is never deleted by Aiden without `force`, and a deleted page's chats land on the first page** (D4). Test: Task 7.
4. **Chat delete, live or recovered at startup, leaves the page and other chats' frames, and a failed delete leaves the chat's claim and artifacts** (Task 9).
5. **The title follow ends on the newest title, writes nothing when no page follows the chat, and never renames a page the person renamed** (D6). Test: Task 4.

## Review amendments (2026-11-23)

Two adversarial reviews (data and races; lifecycle, UI and tests) were settled in `p1b-plan-decisions.md`. Each decision maps to where the plan handles it. Where a decision needed a change against the code, the change is stated.

| # | Decision | Where |
|---|---|---|
| 1 | `changesBetween` applies page changes item by item | Task 1, Review Focus 1 |
| 2 | The save's answer returns the merged claims; the renderer applies them and carries them | D3, Task 2 |
| 3 | Restore a saved claim only when the stored entry is missing or names where the delete moved it | D3, Task 2. *Changed:* the store also keeps an in-memory record of which chats were on each deleted page and where each went. Against the code, the store can't tell a page an undo brings back from a page the renderer just created (both are simply absent from `current`). With only the decision's rule, a renderer could move a chat sitting on the first page onto a new page id, which the decision's own test forbids. The record also replaces `current.pages[0]` with the exact page each chat was moved to, which stays right after the pages are reordered. |
| 4 | Startup recovery prunes fully; claims of missing chats are ignored | Task 9 (recovery), D2, D4, Risk 9. *Changed slightly:* the read before the remove stays at `main/index.ts:2603`. The pre-remove call becomes `scope: "comments"` and a new post-remove call uses `"all"`, matching the live delete instead of moving all pruning before the remove. |
| 5 | The title follow reads the title itself, runs in a per-chat queue, goes through `DesignChatCanvases`, and comes before entry | D6, Task 4, Risk 5 |
| 6a | Rule 3 checks other chats' views; `pageIdsOf` | D2, Task 5 |
| 6b | Lazy claim on the first canvas write | D9, Task 8 |
| 7 | The consent path awaits entry | D8, Task 6 |
| 8 | Fallback order view → claim → earlier → first; report on fallback | D7, Task 3 |
| 9 | One refusal for `force` | D4, Task 7 |
| 10 | Counts only; page names may carry titles | Scope, Global Constraints |
| Minor | `use` on own page writes nothing | Task 7 |
| Minor | Entry always shows | D2, Task 6 |
| Minor | Cap enforced explicitly | Global Constraints, Task 1 |
| Minor | Rule 3 never takes another chat's `namedFor` page | D2 |
| Minor | Pluralised messages, picker labels, accessible name | D4, Task 10 |
| Minor | Prompt line | Task 7 |
| Minor | Undoing A's turn that added Q, after B used it | D4 |
| Minor | Brought-back page with a deleted chat's `namedFor` | D6 |
| Minor | Risk 11 deleted | Scope (phones get no canvas tools) |
| Minor | Guards labelled | Global Constraints and the tasks |
| Minor | Moving an empty chat deletes its empty named page | Task 9 |
| Minor | E2E fixes | Task 11 |
| Minor | PRODUCT.md wording | Task 11 |
| Minor | Worktree confirm only | Task 9 |
| Open questions 1–5 | Settled | Rule 3 (1), Task 10 (2), D9 (3), Task 9 (4), D4 (5) |
| Re-check 1 | Rule 3 never shares an empty page another chat claims | D2 rule 3, Task 6 fixture |
| Re-check 2 | Restore only when `current[C]` is exactly where the delete moved C; `isLive` includes the workspace; the merge never adds entries or refuses | D3, Global Constraints (Cap), Task 2 tests |
| Re-check 3 | The delete record holds `namedFor` too (`DeletedPage`) | D3, Task 1 interfaces, Task 2 |
| Re-check 4 | Dead chats' entries go in entry, `delete` and `use`; Risk 9 corrected | Risk 9 |
| Re-check 5 | Parse drops past the cap instead of refusing; attach carry skips a refused claim | Global Constraints (Cap), D9 |
| Re-check 6 | Lazy claim checks on `next` and waits for a pending entry | Task 8 |
| Re-check 7 | Record changes after a successful write; replace on re-delete; restore removes | D3, Task 2 |
| Re-check 8 | PRODUCT.md wording on images | Task 11 |

---

### Task 1: Shared chat-page rules and page-aware undo

**Files:**
- Create: `renderer/shared/design-canvas/chat-pages.ts`
- Modify:
  - `renderer/shared/design-canvas/schema.ts` (`DesignPage.namedFor`, `DESIGN_CANVAS_LIMITS.chatPages = 2000`)
  - `renderer/shared/design-canvas/pages.ts` (`deletePage` reassigns, `renamePage` clears `namedFor`)
  - `renderer/shared/design-canvas/view.ts` (`chatPageId`)
  - `renderer/design/canvas-history-core.ts` (`changesBetween`)
- Test: create `renderer/shared/design-canvas/chat-pages.test.ts`; extend `schema.test.ts`, `pages.test.ts`, `view.test.ts`, `renderer/design/canvas-history-core.test.ts`

**Interfaces** (all pure; each returns `doc` itself when nothing changes):
- `DesignPage = { id: string; name: string; namedFor?: string }`.
- `chatPageId(doc: Pick<DesignCanvas, "pages" | "chatPages">, view: { pageId?: string } | null | undefined, chatId: string): string`: the view page while it exists, else the claim while its page exists, else the first page.
- `chatsOnPage(doc, pageId, isLive?: (chatId: string) => boolean): string[]`.
- `uniquePageName(doc, base, exceptPageId?)` (D5).
- `claimPage(doc, chatId, pageId, isLive?)`: throws a `ChatPagesFullError` when the cap is reached and no dead chat's entry can be evicted. The caller checks that the page exists.
- `addChatPage(doc, chatId, title, id, after?, isLive?)`: `addPage` with `uniquePageName`, `namedFor` and the claim. Returns `doc` at the page limit.
- `followChatTitle(doc, chatId, title)` (D6).
- `forgetChatOnCanvas(doc, chatId)`:
  - drops the claim and the chat's `namedFor` marks;
  - drops its artifact frames (`kind === "artifact" && chatId === chatId`) and any chat's comments on them (`commentsWithoutFrames`);
  - lets go of connectors (`syncConnectors`) and refits groups (`refitGroups`);
  - leaves the chat's comments to the existing comment pass.
- `forgetChatMove(doc, chatId)`: `forgetChatOnCanvas`, plus deleting the page made for the chat when it has no frames and no comments, no other chat claims it, and it isn't the only page. Otherwise `namedFor` is just cleared.
- `type DeletedPage = { namedFor?: string; claims: Map<string, string> }` (chat id → the page the delete moved it to).
- `mergeSavedChatPages(current, saved, deleted, isLive?)` → `{ doc, changed: boolean, deletedNow: Map<pageId, DeletedPage>, restored: Map<pageId, DeletedPage> }` (D3). `restored` is what the store removes from the record once the write succeeded.
- `deletedClaims(before, after)` → `Map<pageId, DeletedPage>` for every page `after` removed that had claims or a `namedFor`. The store uses it for updates as well as saves.
- `deletePage(doc, id)` reassigns entries naming `id` to the first page left.
- `renamePage` drops `namedFor` when the name changes.
- `changesBetween(from, to)` (decision 1):
  - pages and their `namedFor` change item by item: remove the pages `to` removed, insert added pages after their predecessor in `to` (at the start when they have none), apply renames and `namedFor` changes, take the order from `to` only among pages both share, and keep pages that exist only in the step;
  - claims: apply `to.chatPages`' differences from `from.chatPages` (added, changed, removed) to the step, then reassign entries whose page is gone in the step to the step's first page;
  - comments still follow their frames and pages as today.

- [x] **Step 1: Write failing tests**
  - `canvas-history-core.test.ts`:
    - `a page another writer adds or renames does not stop an undo from bringing back a deleted page, its frames and its comments`. History: the person deletes P (with a frame and a comment). Take in a store update that adds R and renames Q. Undo. P is back, in its old place among the shared pages, with its frame and comment; R and Q's new name are kept;
    - `a claim another writer made reaches every kept step, so undoing a page delete brings back the current claim`. History: delete P (claimed by B), then take in an update where B claims Q. Undo, and the doc has P and `chatPages.B === "Q"`;
    - `a page that exists only in an older step stays in that step after a carry`.
  - `chat-pages.test.ts`:
    - `chatPageId prefers the view's page, then the claim, then the first page, skipping pages that are gone`;
    - `uniquePageName adds the lowest free number and cuts the base so the name stays within 60 characters`;
    - `uniquePageName ignores the page being renamed`;
    - `addChatPage adds a named page after the given page, marks it and claims it; at the page limit it changes nothing`;
    - `claimPage at the cap evicts a dead chat's entry, and refuses when every entry is a live chat's`;
    - `parse keeps the first 2 000 chatPages entries and counts the rest in dropped, without setting the canvas aside` (schema.test.ts);
    - `followChatTitle renames only pages named for that chat, and changes nothing when none is`;
    - `forgetChatOnCanvas drops the claim, the named-for marks and the artifact frames with the comments on them, and keeps other chats' frames, the page and the chat's notes`;
    - `forgetChatOnCanvas lets go of an arrow joined to a removed artifact frame and refits its group`;
    - `forgetChatMove deletes the empty page made for the chat, and keeps a page with frames, a comment or another chat's claim, clearing namedFor`;
    - `mergeSavedChatPages keeps the stored claims when the save carries stale ones`;
    - `mergeSavedChatPages restores a claim for a brought-back page only when the delete record has it and the chat is still where the delete moved it`;
    - `mergeSavedChatPages does not let a save move a chat on the first page onto a new page id`;
    - `mergeSavedChatPages reassigns claims on a page the save removed and records them`;
    - `mergeSavedChatPages never adds namedFor to a stored page without it, and restores it on a brought-back page the record holds`.
  - `schema.test.ts`: `keeps namedFor only when it is a safe chat id`; `refuses more than 2000 chatPages entries`.
  - `pages.test.ts`:
    - replace `deletePage drops chatPages entries for the deleted page` with `deletePage moves the deleted page's chats to the first page left`, including deleting the first page;
    - `renaming a page stops it following its chat`;
    - `duplicating a page copies neither namedFor nor claims` **(guard)**.
- [x] **Step 2:** Run `npx tsx --test renderer/shared/design-canvas/chat-pages.test.ts renderer/shared/design-canvas/schema.test.ts renderer/shared/design-canvas/pages.test.ts renderer/shared/design-canvas/view.test.ts renderer/design/canvas-history-core.test.ts`. Expected: FAIL.
- [x] **Step 3:** Implement. `appendCanvasPages` builds `{id, name}` pages, so it drops `namedFor`; note that in its comment. Register `chat-pages.test.ts` in `scripts/ci-test-registry.json` and `test:design-mode`.
- [x] **Step 4:** Rerun, plus `npx tsx --test renderer/design/use-design-canvas.test.tsx` (history consumer). Expected: PASS. Run `npm run test:ci-policy`.
- [x] **Step 5:** Commit `fix(design): undo keeps deleted pages; chat page rules`.

### Task 2: The store merges claims and the saving canvas sees them

**Files:**
- Modify:
  - `main/services/design-canvas/store.ts` (`save`, `update`, `DesignCanvasSaveResult`, the per-workspace delete record)
  - `main/handlers/design-canvas.ts` (passes the answer through), `renderer/lib/ipc.ts` (the result type)
  - `renderer/design/use-design-canvas.ts` (the `result.ok` branch near line 257)
- Test: `main/services/design-canvas/store.test.ts`, `renderer/design/use-design-canvas.test.tsx`

**Interfaces:**
- `DesignCanvasSaveResult` `ok` arm: `{ ok: true; revision: number; chatPages?: Record<string, string>; namedFor?: Record<string, string> }`. The two optional fields are present only when the merge changed the saved document; `namedFor` maps page id to chat id.
- `save` runs `mergeSavedChatPages(current, parsed.doc, this.deleted(workspaceId))` on the workspace chain, after the revision check and before `withRemovedPagePaths`. After the write succeeds, it replaces the record's entries with `deletedNow` and removes `restored` from it.
- `update` replaces the record's entries with `deletedClaims(current, next)` after its write succeeds. The record is cleared on `delete(workspaceId)`.
- Extra store tests:
  - `a chat deleted or moved after its page was deleted is not brought back by undoing the delete`;
  - `undoing the delete of a page made for a chat that now uses another page brings back its namedFor`;
  - `a write whose beforeWrite throws leaves the delete record unchanged`;
  - `deleting the same page id twice and undoing restores the claims of the newest delete only`.
- Renderer, on `ok` with those fields:
  - `server = applyStoredClaims({ ...doc, revision })`;
  - `local` gets the same claims (`applyStoredClaims(local)`);
  - `history = takeIn(history, { before: local, from: doc, to: server })` with no `aidenTurn`, so the claims reach every kept step and make no step.

- [x] **Step 1: Write failing tests**
  - `store.test.ts`:
    - `a person's save cannot add or move a claim`: store `{A: P1}`; save `{A: P2, B: P1}`, both pages present; stored stays `{A: P1}`, and the answer carries `chatPages: {A: P1}`;
    - `a stale claim in a save after the chat's own turn does not move it back` (review A's M1): A's turn claims Q (update); A's canvas, still holding `{A: P}`, saves an unrelated edit at the new revision; the stored claim stays Q;
    - `an undo that brings a deleted page back brings its claims back`: P1, P2 and `{B: P2}`; save without P2 (B moves to P1); save with P2 and `{B: P2}`; B is on P2;
    - `a renderer cannot move another chat's claim to a new page id`: `{B: P1}` with P1 first; save a new page P9 and `{B: P9}`; B stays on P1;
    - `a page Aiden deletes is recorded, so the person's undo of a later edit cannot resurrect claims for it unless it brings the page back`;
    - `a save that deletes a page moves its chats to the first page, even when the renderer's copy forgot them`;
    - `a save cannot mark a page as following a chat`.
  - `use-design-canvas.test.tsx`: `undoing a turn that used a page keeps the picker on the stored claim`. The fake save answers with `chatPages`; after the save the hook's `doc.chatPages` equals the stored ones, and one more undo does not bring the stale claim back.
- [x] **Step 2:** Run `npx tsx --test main/services/design-canvas/store.test.ts renderer/design/use-design-canvas.test.tsx`. Expected: FAIL.
- [x] **Step 3:** Implement. Update the `save` doc comment to say claims are main's, and how the record works.
- [x] **Step 4:** Rerun, plus `npx tsx --test main/handlers/design-canvas.test.ts`. Expected: PASS.
- [x] **Step 5:** Commit `feat(design): saves keep main's chat pages and report them back`.

### Task 3: Page resolution falls back to the claim, on both sides

**Files:**
- Modify: `main/services/design-canvas/views.ts` (`designTurnPages`), `renderer/design/use-design-view.ts` (`shownPageId`, report scheduling)
- Test: `main/services/design-canvas/views.test.ts`, `renderer/design/use-design-view.test.tsx`, `renderer/design/design-canvas.test.tsx`

**Interfaces:**
- `DesignTurnPages.resolver(workspaceId)` returns `(doc: Pick<DesignCanvas, "pages" | "chatPages">) => DesignChatView`, with `doc.chatPages[chatId]` between the kept view page and the first page. `view()` takes the same `Pick`.
- `shownPageId(doc, state, chatId)`: the view page, the claim, the newest existing earlier page, then the first page.
- When the shown page differs from `state.pageId` (a fallback), the hook schedules a report of the shown page, through the 250 ms debounce.

- [x] **Step 1: Write failing tests.** Check that each fails before the change.
  - `views.test.ts`:
    - `with no view, a turn works on the chat's claimed page`;
    - `when the view's page is gone, a turn works on the claim before the first page`;
    - `the view still wins over the claim` **(guard)**.
  - `use-design-view.test.tsx`:
    - `when the view's page is gone, the canvas shows the claim before an earlier page`: state with `earlier: [P1]`, the claim on P3, the view's P2 deleted; the shown page is P3;
    - `a canvas with no kept view opens on the claim`;
    - `a fallback page is reported to main`: the fake `reportDesignCanvasView` receives P3 after the debounce.
  - `design-canvas.test.tsx`: `when another chat deletes the page on screen, the canvas shows this chat's claim`.
- [x] **Step 2:** Run `npx tsx --test main/services/design-canvas/views.test.ts renderer/design/use-design-view.test.tsx renderer/design/design-canvas.test.tsx`. Expected: FAIL (except the guard).
- [x] **Step 3:** Implement. Update both doc comments. Remove A12's "1b note" wherever 1a left it in code comments.
- [x] **Step 4:** Rerun, plus `npx tsx --test main/services/design-canvas/canvas-tools.test.ts main/services/design-canvas/written-pages.test.ts`. Expected: PASS.
- [x] **Step 5:** Commit `feat(design): a chat falls back to its own page`.

### Task 4: Title listeners and the title follow

**Files:**
- Modify: `main/services/chat-store-core.ts`, `main/services/design-canvas/main.ts`
- Create: `main/services/design-canvas/title-follow.ts`, `main/services/design-canvas/title-follow.test.ts`
- Test: `main/services/chat-store-core.test.ts`, the new test (register it)

**Interfaces:**
- `chatStore.onTitleChanged(listener: (chatId: string) => void): () => void`.
  - Fired once after `rename`, `replaceTitleIfUnchanged`, `replaceAutoTitle`, or an `appendMessage` that seeded the title, resolves with a changed title. That is after the method's `shared(...)` returns, outside the chat lock.
  - A listener that throws is caught and logged, as `onIndexChanged` does (`chat-store-core.ts:539`).
- `createDesignTitleFollow({ canvases: Pick<DesignChatCanvases, "update" | "workspaceIdOf">, titleOf(chatId): Promise<string | undefined>, broadcast })` returns `{ follow(chatId): Promise<void> }`.
  - Calls for one chat run one after another (a per-chat promise chain). A call queued behind a running one for the same chat merges into the next run.
  - Each run reads the title when it starts and updates through `DesignChatCanvases.update(chatId, …)`, writing nothing (sentinel) when `followChatTitle` returns `doc`.
  - It broadcasts `{ workspaceId, chatId, revision }` and logs failures. A chat or workspace that is gone is a no-op.
- `main.ts` subscribes `chatStore.onTitleChanged((chatId) => void designTitleFollow.follow(chatId))` and exports `designTitleFollow` for entry (Task 6).

- [x] **Step 1: Write failing tests**
  - `chat-store-core.test.ts`:
    - `a rename, a replaced title, an auto-title and the first-message seed each tell title listeners once, after the write`;
    - `a rename that changes nothing tells no one`;
    - `a listener that throws does not fail the rename`.
  - `title-follow.test.ts` (real `DesignCanvasStore` on a temp root, `DesignChatCanvases` with fakes):
    - `a chat's rename renames the page made for it and tells open canvases`;
    - `a page the person renamed no longer follows`;
    - `a rename of a chat with no page made for it writes nothing` (revision unchanged);
    - `a title another page already has gets a number`;
    - `two quick renames and an entry running at once end on the newest title`: three `follow` calls race a `titleOf` that changes between them; the final page name is the last title, and no run writes after a newer one;
    - `a follow after the workspace was removed writes no file`.
- [x] **Step 2:** Run `npx tsx --test main/services/chat-store-core.test.ts main/services/design-canvas/title-follow.test.ts`. Expected: FAIL.
- [x] **Step 3:** Implement. Register the new test. `packages/cli` bundles `chat-store-core.ts`, so run `npm run cli:build`.
- [x] **Step 4:** Rerun. Expected: PASS. Run `npm run test:ci-policy`.
- [x] **Step 5:** Commit `feat(design): a page made for a chat follows its title`.

### Task 5: Other chats' kept views

**Files:**
- Modify: `main/services/design-canvas/views.ts`
- Test: `main/services/design-canvas/views.test.ts`

**Interfaces:** `DesignCanvasViews.pageIdsOf(workspaceId, exceptChatId): Promise<Set<string>>`, the kept view pages of every other chat on that workspace. It loads the views file the way `get` does.

- [x] **Step 1: Write failing tests:** `pageIdsOf lists other chats' kept pages, not the asking chat's, and reads them from the file after a restart`.
- [x] **Step 2:** Run `npx tsx --test main/services/design-canvas/views.test.ts`. Expected: FAIL.
- [x] **Step 3:** Implement.
- [x] **Step 4:** Rerun. Expected: PASS.
- [x] **Step 5:** Commit `feat(design): main can list the pages other chats look at`.

### Task 6: Entry claims the chat's page

**Files:**
- Modify:
  - `main/services/design-canvas/written-pages.ts` (`entryPlacement`, `placeWrittenPagesOnCanvas`, `retractPlacedFrames`)
  - `main/services/chat-application-service.ts` (`setDesignMode` option `awaitEntry`)
  - `main/services/chat-application-service-main.ts` (`designPagesOnEntry` wiring)
  - `main/handlers/design-canvas-main.ts:41` (the consent `enter` passes `awaitEntry: true`)
- Test: `main/services/design-canvas/written-pages.test.ts`, `main/services/chat-application-service.test.ts`

**Interfaces:**
- `entry?: { pageName: string; otherViews(workspaceId): Promise<Set<string>>; isLive(chatIds: string[]): Promise<Set<string>> }`; `hasView` is removed.
  - Before the update, entry reads the doc's claimed chat ids through `isLive`, and other chats' views through `otherViews`.
  - The mutate applies D2. A claimed chat id not checked counts as live.
- With `entry`, there is no early return when no written page exists. The update claims, and the no-change short cut (`UNCHANGED`) applies only when no frame is placed and the claim didn't change.
- The result always has `pageId`, the chat's page, and `focusId` from the `show` that always follows.
- `shouldSave` false (design mode turned off meanwhile) writes neither frames nor claim, and shows nothing.
- `retractPlacedFrames`, given the page entry added, removes the chat's claim on it as well as the page.
- `designPagesOnEntry` keeps `pageName: chat.title`. After the claim, it calls `designTitleFollow.follow(chat.id)` (Task 4).
- `setDesignMode(chatId, enabled, options & { awaitEntry?: boolean })`: with `awaitEntry`, it awaits `designPagesOnEntry` (logging, not throwing, on failure) before returning. The consent `enter` passes it, so the `design_mode` tool answers "entered" only after the claim.

- [x] **Step 1: Write failing tests** (edit the A21 tests that assumed 1a's rule, seeding claims where needed):
  - `the first chat on a fresh canvas claims Page 1 without renaming it, adds no page, and shows it`, with no written pages;
  - `chat B entering a workspace whose first page is chat A's gets a page named after B, claimed and shown`: `chatPages: {A: page-1}`, A alive, page-1 holding no frames (so the test pins that an empty claimed page is not shared), B with no written pages;
  - `a page with frames that another chat's kept view is on is not taken; B gets its own page`: no claims, A's view on page-1;
  - `a page with frames that only this chat has looked at is claimed as it is` (the 1a-upgrade case);
  - `a claim of a chat that no longer exists does not stop the page being claimed`;
  - `a page named for another chat is never taken by rule 3`;
  - `a chat entering again keeps its claim, adds no page and still shows it`;
  - `the chat's earlier pages already on the canvas make the page holding most of them its claim`;
  - `two chats entering a fresh canvas at once end on Page 1 and a new page`;
  - `B's new page is numbered when a page already has B's title`;
  - `at the page limit, a chat whose page is taken shares it`;
  - `leaving design mode while entry's file is being written takes back the added page and the claim on it`;
  - `with design mode turned off before the write, no claim is made and nothing is shown`;
  - `chat-application-service.test.ts`: `entering design mode from Aiden's card waits for the chat's page, so a placement right after lands on it`. A fake entry resolves late; `setDesignMode(..., { awaitEntry: true })` resolves only after it, and a placement through `designTurnPages` then lands on the claimed page.
- [x] **Step 2:** Run `npx tsx --test main/services/design-canvas/written-pages.test.ts main/services/chat-application-service.test.ts`. Expected: FAIL.
- [x] **Step 3:** Implement with Task 1's helpers. Rewrite the `entryPlacement` doc comment to list D2's rules.
- [x] **Step 4:** Rerun, plus `npx tsx --test main/services/design-canvas/design-mode-tool.test.ts`. Expected: PASS.
- [x] **Step 5:** Commit `feat(design): a chat claims its page when design mode opens`.

### Task 7: `canvas_page use`, one delete refusal, and page marks for Aiden

**Files:**
- Modify: `main/services/design-canvas/canvas-tools.ts`, covering:
  - `canvas_page` (line 1655);
  - `pagesAnswer` (line 934);
  - the design-mode prompt line near 209;
  - the load-on-demand summary near 800.
- `DesignCanvasToolDeps` gains `isLive?(chatIds: string[]): Promise<Set<string>>` (production: `chatStore.getMeta`), wired in `llm-client.ts`.
- Test: `main/services/design-canvas/canvas-tools.test.ts`; `skill.test.ts` only if `skill.ts` text changes (it defers to the tools today).

**Interfaces:**
- **`use`.** The `action` enum gains `"use"`, which needs `page`.
  - First it reads. If the chat's claim already names the resolved page, it only shows the page and writes nothing.
  - Otherwise it runs an `edit` whose mutate resolves the page with `pageOf` on the latest document. If the claim already names that page there, it throws a no-change sentinel; else it calls `claimPage`. Either way it returns `show`.
  - Answer: `{ status: "done", action: "use", page: { id, name }, pages }`.
- **`delete`.**
  - Before the edit, it reads which claimed chats are live (`deps.isLive`).
  - Inside the mutate, without `force`, it counts the person's/locked frames and the other live chats' claims, and refuses once with D4's pluralised message naming whichever apply.
  - With `force`, or when neither applies, it deletes (`deletePage` reassigns).
- **`pagesAnswer`** entries gain `yours: boolean` and `otherChats: number` (live chats only).
- **Description:** `"…move (step -1 or 1), show, or use (make it this chat's own page and show it) a design canvas page… delete needs force: true for a page holding the person's or locked frames or used by another chat, only when they asked."`
- **Prompt line** replaces line 209's first clause: `"Work on the page the person is looking at, which starts as this chat's own page, unless they name another; canvas_page use makes a page this chat's page."`

- [x] **Step 1: Write failing tests**
  - `canvas_page use makes the page this chat's and shows it, leaving other chats' claims alone`;
  - `canvas_page use on a missing page is refused and writes nothing` (revision unchanged);
  - `canvas_page use on the chat's own page writes nothing and still shows it` (revision unchanged, `focus` called);
  - `canvas_page delete refuses a page another live chat uses, and with force deletes it and moves that chat to the first page`;
  - `canvas_page delete names both reasons once when the page holds the person's frames and another chat's claim`;
  - `canvas_page delete ignores the claim of a chat that no longer exists`;
  - `canvas_page delete of this chat's own page needs no force`;
  - `the pages list marks this chat's page and counts other chats, naming none of them`: no other chat's id or title appears in the answer;
  - `after canvas_page use, a placement with no page in the same turn lands on the used page` **(guard: A1's `shown` step already does this; kept to pin `use` going through it)**.
- [x] **Step 2:** Run `npx tsx --test main/services/design-canvas/canvas-tools.test.ts`. Expected: FAIL (except the guard).
- [x] **Step 3:** Implement.
- [x] **Step 4:** Rerun, plus `npx tsx --test main/services/llm-client*.test.ts`, in case tool schemas or prompt text are asserted by replay. Expected: PASS.
- [x] **Step 5:** Commit `feat(design): canvas_page use and pages other chats rely on`.

### Task 8: Lazy claim on a chat's first canvas write

**Files:**
- Modify:
  - `main/services/design-canvas/canvas-tools.ts` (`edit`, line 884)
  - `main/services/design-canvas/written-pages.ts` (`placeWrittenPagesOnCanvas` without `entry`)
  - `main/services/design-canvas/artifact-frames.ts` (`placeArtifactsOnCanvas` line 107, `placeImagesOnCanvas` line 189)
- Test: `canvas-tools.test.ts`, `written-pages.test.ts`, `artifact-frames.test.ts`

**Behaviour:** Inside the mutate of each design-turn write, after the write's own change, the write checks `next.chatPages[chatId]` and takes the page the write landed on: the page it shows (`canvas_page add` or `duplicate`), else the page of the frames it added or changed, else the turn's page. A delete lands on no page. When the chat has no claim and that page exists in `next`, it calls `claimPage(next, chatId, pageId)`. Answers that list pages (`pagesAnswer`) are built after the claim. At a full `chatPages` the write skips the claim, then asks which claimed chats are live and claims in a follow-up write when a gone chat's entry makes room (`claimWithRoom`).
- Checking on `next` keeps a `canvas_page use` claim made by this same write, and never claims a page this write deleted.
- While an entry for the chat is pending, the lazy claim waits for it: main keeps a per-chat promise for a running entry (`pendingEntries`, set by `designPagesOnEntry` and cleared when it settles, whichever path turned design mode on, including the toolbar's `chat-renderer-mutations.ts:145`), and the design-turn write awaits it before its update.
- It runs only when the write changes something else; a refused or no-change write claims nothing.
- Never on reads (`canvas_read`, `canvas_inspect`), never on mount, never in the person's `designCanvas:placeArtifact` (`main/handlers/design-canvas.ts:415`, not a design turn).
- A cap refusal from `claimPage` skips the claim and lets the write land.

- [x] **Step 1: Write failing tests**
  - `a chat with no claim claims the page its first tool edit lands on, in the same write` (one revision bump);
  - `canvas_read claims nothing`;
  - `a written page auto-placed in a turn claims for a chat with none`; `an artifact placed in a turn claims for a chat with none`;
  - `a chat that has a claim keeps it when it writes on another page`;
  - `canvas_page use and a frame placed in the same write keep the use claim`;
  - `a write that deletes the turn's page claims nothing`;
  - `a write during a pending entry waits for it and keeps the entry's claim`.
- [x] **Step 2:** Run `npx tsx --test main/services/design-canvas/canvas-tools.test.ts main/services/design-canvas/written-pages.test.ts main/services/design-canvas/artifact-frames.test.ts`. Expected: FAIL.
- [x] **Step 3:** Implement with one helper in `chat-pages.ts`, `withLazyClaim(doc, chatId, pageId)`.
- [x] **Step 4:** Rerun. Expected: PASS.
- [x] **Step 5:** Commit `feat(design): a chat claims the page its first write lands on`.

### Task 9: Lifecycle

**Files:**
- Modify:
  - `main/services/design-canvas/cleanup.ts`: `forgetChat(chatId, workspaceId, scope: "comments" | "all" | "move")`, with `scope` required so `tsc` finds every caller.
    - `"comments"` is 1a's pass.
    - `"all"` adds `forgetChatOnCanvas` in the same update.
    - `"move"` adds `forgetChatMove`.
    - Each skips the write when nothing changes.
  - `main/services/chat-application-service.ts`:
    - the live delete's pre-commit pass (line 840) uses `"comments"`, and the post-commit pass (line 857) uses `"all"`;
    - `moveEmptyToWorkspace` uses `"move"`.
  - `main/index.ts:2603-2605` (`reconcilePendingChatDeletions`):
    - keep `getMeta` before the remove and capture the workspace id;
    - the pre-remove call uses `"comments"`;
    - after `chatStore.remove`, call `forgetChat(chatId, workspaceId, "all")`, logging failures.
  - `main/services/design-canvas/carry.ts`: the same update claims `merged.pageIds[0]` for `input.chatId` (D9).
- Test: `main/services/chat-application-service.test.ts`, `main/services/design-canvas/carry.test.ts`, and a recovery test where the reconcile callback is reachable. If `reconcilePendingChatDeletions`' callback lives only in `main/index.ts`, extract it into a small function in `cleanup.ts` (`recoverDeletedChatCanvas(deps, chatId)`) and test that function.

- [x] **Step 1: Write failing tests**
  - `deleting a chat drops its claim, its named-for mark and its artifact frames, and keeps the page, its notes and other chats' frames and claims`;
  - `a delete that fails after the first cleanup keeps the chat's claim and artifact frames` **(guard: nothing prunes them before 1b; pins that the pre-commit pass stays comments-only)**;
  - `a canvas save that lands while the chat is being deleted does not bring back its claim or artifact frames` (extends the A25 case);
  - `a chat delete recovered at startup prunes the claim and artifact frames after the remove`;
  - `moving an empty chat drops its claim and deletes the empty page made for it; a page with frames stays, no longer following`;
  - `carry.test.ts`: `an attached chat claims the first page it brought along`; `when nothing comes along, no claim is made` **(guard)**.
  - Worktree: confirm `workspace-worktree-application-service.test.ts` still asserts that create rollback and managed delete call `removeWorkspace` (from line 18, rollback cases near 174 and 814). No new test.
- [x] **Step 2:** Run `npx tsx --test main/services/chat-application-service.test.ts main/services/design-canvas/carry.test.ts` and the recovery test. Expected: FAIL (except guards).
- [x] **Step 3:** Implement. Update the `cleanup.ts` header comment: a deleted chat's artifact frames and claim go after the delete commits, while its other frames stay as the workspace's work.
- [x] **Step 4:** Rerun. Expected: PASS.
- [x] **Step 5:** Commit `feat(design): chat delete takes its page claim and artifacts off the canvas`.

### Task 10: The page picker shows how many chats use each page

**Files:**
- Modify: `renderer/design/design-toolbar.tsx` (`DesignPageMenu`, line 280), and the prop passing `chatId` from `renderer/design/design-canvas.tsx`
- Test: `renderer/design/design-canvas.test.tsx`, or a toolbar test beside it

**Behaviour.** First read `docs/chatgpt-desktop-ui-inspiration.md`, `docs/chatgpt-ui-element-specimen.html` and `docs/design-guide.md`. Then each page row shows a trailing label in tertiary `text-small`, the pattern in `docs/design-guide.md:286`:
- `"This chat"` on this chat's claim;
- `"This chat · N more"` when others share it;
- `"1 chat"` or `"N chats"` on a page only others use;
- nothing on a page no chat uses.

Each row's accessible name is the page name, a comma, then the label (`"Page 1, This chat"`). The trigger's `aria-label` stays `Page: <name>`. Counts only; no titles. Semantic tokens only, with no new colours, borders or badges.

- [x] **Step 1: Write failing tests:** `the page picker marks this chat's page and counts other chats on theirs`. Use Testing Library: open the menu and assert each row's accessible name, covering all four labels.
- [x] **Step 2:** Run `npx tsx --test renderer/design/design-canvas.test.tsx`. Expected: FAIL.
- [x] **Step 3:** Implement.
- [x] **Step 4:** Rerun. Expected: PASS. Take before and after screenshots of the open picker with two chats, light and dark, for the PR body.
- [x] **Step 5:** Commit `feat(design): the page picker shows each page's chats`.

### Task 11: Two-chats E2E, docs and memory

**Files:**
- Modify: `tests/e2e/design-canvas.spec.ts` (new test; extend `savedCanvases`' type with `chatPages` and `namedFor`)
- Docs: `PRODUCT.md` (design-mode paragraph, line 69), `README.md` (only if its design-mode line mentions pages), `docs/plans/README.md` (the v2 row), `.memory/design-mode.md`, and this plan's checkboxes.

- [x] **Step 1: Write the E2E** `two chats on one workspace each get their own page, keep it across switches, and a page another chat uses is not deleted without force`:
  1. Chat A sends "Design the Northwind landing page" and runs `/design`. Assert the saved doc's `chatPages[A] === pages[0].id`.
  2. A's turn places a note through `canvas_place_frame` (fake model tool scenario).
  3. Start chat B in the same workspace. It sends "Sketch the pricing table" and runs `/design`.
     - Wait until B's title has settled (poll the title bar until the auto-title has replaced the seed, or turn auto-title off for this test through the fixture).
     - Then assert the picker trigger reads `Page: <B's title>`, and A's note is not on screen.
     - Assert the saved doc has a second page with `namedFor === B` and `chatPages[B]` naming it.
     - Don't assert "no jump" during entry: entry moves B's canvas to its page by design.
  4. B's turn places a note. Switch to A: A's page is on screen with only A's note. Switch back to B: B's page.
  5. Open the picker in B. B's page row is named "<B's page>, This chat", and Page 1 "Page 1, 1 chat".
  6. B's turn calls `canvas_page {action: "delete", page: "Page 1"}`. The scenario's result contains "1 other chat", and Page 1 still exists.
  7. Rename B from the sidebar. The picker trigger and the saved page name follow.
  8. Delete chat B. The saved doc has no `chatPages[B]`, B's page is still there with B's note, and that page has no `namedFor`.
  9. Capture `1440-canvas-two-chats` for the PR body.
- [x] **Step 2:** Run `npm run test:e2e:space -- tests/e2e/design-canvas.spec.ts`. Fix until it passes. If an existing test fails because entry now claims, update the expectation only where the claim causes it, and say so in the commit.
- [x] **Step 3: Docs**
  - `PRODUCT.md`, after "each chat remembers its own page and view":
    > "Opening design mode gives the chat a page of its own: the page on screen when no other chat is using it, otherwise a new page named after the chat, which follows the chat's title until someone renames the page. Aiden can switch the chat to another page. Deleting a page moves its chats to the first page, and Aiden won't delete a page another chat uses unless the person asks. Deleting a chat removes its comments, its page claim, and the images and visuals it sent from the chat (artifact frames); workspace images, its page, notes and page frames stay."

    Replace "landing on the chat's empty page" with "landing on the chat's page".
  - `docs/plans/README.md` v2 row: "Phase 1b (chat pages) built <date>, in review as PR #<n>, plan [p1b](../superpowers/plans/2026-11-23-design-mode-v2-p1b-chat-pages.md)."
  - `.memory/design-mode.md`: add a "v2 Phase 1b: chat pages" section with D1–D10 and the delete record in short form, and replace "Phase 1b still owns `chatPages` writes and `canvas_page use`".
  - Search the docs for stale claims: `rg -n "chatPages|own page|page per chat|empty page" README.md PRODUCT.md docs .memory`.
- [x] **Step 4: Verify the whole phase** (below).
- [x] **Step 5:** Commit `feat(design): two chats keep their own pages; docs`.

## Verification

Run, in order, each expected to pass:
- `npm run test:design-mode`
- `npx tsx --test main/services/chat-application-service.test.ts main/services/chat-store-core.test.ts`, which are outside `test:design-mode`
- `npm run type-check` and `npx tsc --noEmit -p main/tsconfig.json`
- `npm run type-check:e2e`
- `npm run cli:build` (Task 4 touches `chat-store-core.ts`, which the CLI bundles)
- `npm run lint`
- `npm run test:ci-policy`
- `npm run test:e2e:space -- tests/e2e/design-canvas.spec.ts tests/e2e/design-mode.spec.ts`

Then `npm run test` once before the PR. CI must be green on the exact head.

## Risks and edge cases

For reviewers to attack:

1. **The delete record is memory only.** A main crash with the renderer alive is impossible: the window goes with it. But a renderer reload keeps main's record while the history is lost, which is harmless. A record evicted after 200 claimed-page deletes in one workspace means an undo of an old delete brings the page back without its claims; those chats stay where they were moved.
2. **Page-aware undo (decision 1).** Inserting a brought-back page "after its predecessor in `to`" needs a predecessor that still exists. When it is gone too, the page goes after the nearest earlier page that exists, else first. Attack the case where two steps restore pages whose predecessors are each other.
3. **Merge answer and history.** The renderer applies the stored claims as a carried change. If the save that got them was a replay after a conflict, `local` may already hold newer edits; `applyStoredClaims` touches only `chatPages` and `namedFor`, so it can't overwrite them.
4. **Title-follow cost.** Every title change reads its workspace canvas once. Auto-titles happen once per chat, so the cost is small, but a canvas near 16 MiB pays a parse per rename.
5. **Title-follow ordering and a failed write.** The per-chat queue and reading the title at run time make the newest title win. If `writeChatAndMeta` fails after the payload file was renamed into place (`chat-store-core.ts:1324`; meta update or transaction clear throws), the method throws and no listener fires. The page keeps its old name until the next title change, whose follow reads the newest title.
6. **Retraction and claims.** Leaving design mode while entry writes takes back the added page and its claim. A claim on an existing page (rule 3) stays after a retraction; the next entry keeps it.
7. **Lazy claim breadth.** Placing an artifact in a turn claims the resolved page for a chat with no claim. That page may be another chat's page that this chat's person was looking at. That is intended: the person was working there.
8. **Delete refusal counts claims only.** A chat that uses a page without a claim (D10) is not protected until its first write or entry.
9. **Crash windows in chat delete.**
   - Live delete: the claim and artifacts are pruned after `chatStore.remove`. A crash between the remove and that prune leaves them. The pending marker is still set then (it is cleared later, near `chat-application-service.ts:866`), but `getMeta` already returns null (`chat-store-core.ts:2312`), so recovery's `if (meta)` (`main/index.ts:2602-2603`) has no workspace id and prunes nothing.
   - Entry, `canvas_page delete` and `canvas_page use` already read which claimed chats are live before their update; in the same mutate they drop the entries of chats that are not live. So the leftover goes at the next of those writes in the workspace. Artifact frames of such a chat show their missing state (1a).
   - Until then the picker, which can't check liveness, still counts the claim ("1 chat"). That is accepted: the window is one crash between two awaits.
10. **Shared page and `namedFor`.** Chat B uses chat A's named page, and A is renamed. The page follows A's title, which may surprise B. That is the spec's rule.
11. **Existing E2E expectations.** Rule 3 keeps Page 1's name, so existing assertions on `["Page 1", "Page 2"]` hold. Entry now writes `chatPages` into saved docs that tests read: check `savedCanvases` callers for deep-equal assertions.
12. **Awaiting entry in the consent path.** The card's answer waits for entry's file reads and one canvas write. Entry already limits itself to `EARLIER_PAGES_LIMIT` pages, so the wait is short. A failure is logged, and the tool still answers "entered".

## Open questions

None of the earlier five remain (see Review amendments). New:

1. **Picker counts and deleted chats** (Risk 9). Should the renderer hide claims of chats it doesn't know, using the chat list it may have? *Settled:* no. Counts stay document-only; the leftover needs a crash in a narrow window and goes at the workspace's next entry or `canvas_page` write.
