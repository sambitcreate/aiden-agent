# Smarter artifacts, inline visuals and design mode

Status: Active (2026-11-18). Branch `feat/smarter-artifacts-design-mode`, one PR.

Source: the "Making artifacts and design mode smarter for Aiden" review (2026-11-17, five Opus 5.5 reviewers against `main` at that date). It found 33 numbered problems, a Tier 4 polish list and seven bigger ideas. The common thread: Aiden builds things it cannot see or read back, and some of its instructions point the wrong way.

## Owner decisions (2026-11-18)

- Scope: every batch (A, B, C, D, E), all of Tier 3 and all of Tier 4, in **one PR**.
- Run it as the phased build loop: phases A → B → C → D → E on one branch; after each phase two Opus reviewers and a fix loop; a final four-reviewer integration pass; then the PR and one CI watcher.
- Item 8 (canvas status line breaks prompt caching): move it out of the system prompt into a short conversation note sent only on turns where the counts changed.
- Item 9 (artifact saves eat the 5-version history): skip saves that change nothing, and fold all of one agent turn's saves into a single undo step. Keep the cap at 5.
- Item 10 (shell-made pages never reach the canvas): auto-place them. After each terminal command in design mode, look for new or changed `.html` pages in the design folder and place them.
- Item 15 (co-editing): Aiden's canvas changes in one turn become one undo step on the person's stack, earlier history is kept, and Aiden is told when a frame it touches moved since it last looked.
- Item 33 (artifact button arguments that run other programs): confirm first with a failing case in the existing real-shell test, then restrict what page data may fill and allow safe joined forms such as `HEAD:{{branch}}`.
- Idea 2 / item 12 (find-and-replace edits): all-or-nothing. Each old text must match exactly once; any miss saves nothing and the error names the failing edit and why.
- Idea 4 (keep a visual): "Keep in Artifacts" and "Send to canvas" go in the visual's existing actions menu, shared squircle treatment, no new always-visible chrome. Light and dark screenshots before merge.
- Idea 5 (design system first): Aiden detects the project's colors and fonts and offers a tokens file plus a specimen page; it writes them only after the person agrees.
- Item 32 (phones on `aiden serve` never see visuals): render visuals to images with an installed Chrome or Chromium found at fixed known paths only (no download, no new bundled dependency, Docker image unchanged). Without one, send a text or table fallback. Either way the tool result tells Aiden what the reader sees.

## Phases

Effort tags from the review: S = hours, M = 1–2 days, L = 3+ days.

### A. Quick wins (items 1–10, 33)

1. Offer the component guide whenever `workspace_artifact` is offered; mention inline visuals only when they exist.
2. Design mode offering: lead `design_mode`'s description with a trigger sentence; one line in the visuals instructions sending whole pages, app screens and multiple directions to design mode; fix the skill's "not available here" dead end.
3. Per-tool "use when" routing lines for on-demand tools instead of the 90-character cut.
4. Unsafe-HTML check matches `javascript:` / `<base` only where they would load something, and quotes the match in the error.
5. Run the artifact page check after every inline visual and add findings to the tool result.
6. Show item shapes for list props in the component guide; warn when items do not match.
7. Placing a file that already has a frame reuses it unless a copy is asked for; locked frames refuse with the id; the result says reused or copied.
8. Canvas status line moves to a conversation note (see decisions).
9. No-op artifact saves make no version; one turn's saves fold into one undo step.
10. Auto-place shell-made design pages (see decisions).
33. Artifact action argument safety (see decisions).

### B. Aiden checks its own work (items 11, 26, 27; idea 1)

- `canvas_inspect`: render one design page at its real width in the hidden offline export window; return the image plus errors, failed loads, overflow, page height and which tweak controls worked.
- After a design write, the inspect report is added to the next step automatically. One shared "what's wrong" format across inline visuals, artifacts and the canvas.
- Raw HTML visuals compile each script before showing it and return errors with their line.
- Comments: link images to their comment, include the element's HTML and the frame's light or dark state, add resolve and reply.

### C. Edits instead of rewrites (items 12, 21, 22, 29; idea 2)

- Store page source with each artifact version; `get` returns source, each data source's status, last error and a short sample; `check` re-runs data without saving.
- Find-and-replace edits for artifact pages and visuals (all-or-nothing).
- Merge inside the store lock; optional base version, refused if it changed.
- Better data-source errors (head and tail, bad-output snippet, separate file-problem messages).
- Reuse fresh data results on saves and add a one-line data shape per source.

### D. Canvas power tools (items 13, 15, 18, 19, 23, 24, 25; ideas 6, 7)

- Batch build tool for boxes and arrows with local ids; a clear stop message at the per-turn cap.
- Co-editing safety and one undo step per Aiden turn.
- File path accepted wherever a frame id is.
- Removed pages stay removed unless asked.
- Artboard wrapping and group refit.
- Inline visuals skip locked and other-page frames and never merge two visuals from one turn.
- Place next to a frame; duplicate any frame or group; variants in one call.

### E. Faster, clearer tool choice (items 14, 16, 17, 31, 32; ideas 3, 4, 5)

- Preload visual tools on `/visualize` turns and in design mode; include the guide when a visual tool loads.
- Selection and real view size sent with each design-mode message and in `canvas_read`.
- One shared routing rule across visuals, artifacts, canvas and images.
- Image generation can save to a workspace path and place on the canvas.
- Server visuals for phones (see decisions).
- Keep in Artifacts / Send to canvas; design-system-first offer.

### Tier 3 leftovers and Tier 4 polish

Folded into whichever phase touches the same file: items 20, 28, 30 and the Tier 4 list (canvas tool description trim, post-entry tool list, wrong guide section, 64 KB data limit note, same-title replacement notice, error message fixes, arrange ordering, screenshot answers, consent card timeout and "Not now" lifetime, canvas read paging and comment text as data, only design-folder pages land, tweak name checks, artifact lookup caching, stale docs).

## Progress

- 2026-11-18: plan written from the review and the owner's answers.
- 2026-11-18: Phase A implemented: items 1 (guide with artifacts when visuals are off), 2 and 3 (design_mode trigger, per-tool routing lines), 4 (unsafe-HTML check only where it loads something, quoted), 5 (page check after every inline visual), 6 (list item shapes in the guide and the check), 7 (reuse a page's frame, refuse locked, `placed` reused/copy/new), 8 (canvas counts as a conversation note on change), 9 (no-op saves make no version, one version per reply), 10 (shell-made `design/` pages land on the canvas; nothing outside `design/` does) and 33 (refuse placeholders in options that start a program, allow ones joined to plain text), plus the Tier 4 polish in the same code (replaced-visual notice, repairs say redraw now, the page `<Data>` limit, duplicate-title errors name the id). Deferred to later phases: canvas tool description trim, arrange ordering, screenshot answers, consent card timeout, canvas read paging, tweak name checks, artifact lookup caching, and the save error's size limit.
- 2026-11-18: Phase A review round 3: a template with a `{{param}}` is parsed by Aiden's own grammar and run without a shell (pipes, `&&`, `||`, `;` and three redirections handled by the host); options are read as the programs read them, short clusters (`-qx`) included, through per-program tables of the letters that take a value; where a placeholder sits decides what its value may be (no remote, worktree path or jq filter; a branch without `+` or `:`; a file inside the workspace; a leading `-` only after `--`). The HTML check reads the bytes that render, where they render (the unwrapped fragment and the markup as written, each after the guest head's `<body>`), and every render path shares that cached verdict. Content the parser moves out of a table is capped at 16,384 pieces and placed by searching from the table's end, so a cap-sized foster-parenting visual is refused in milliseconds. A streaming draft rereads an unfinished start tag on every chunk only while it is under 1 KiB, then each time it doubles, so a long unfinished tag streamed in 64-byte chunks stays linear. Markup with a `<noscript>` is also read with scripting off, so what it shows with scripts turned off is checked too. A `/` after an `if`/`while`/`for`/`with` head is read as the start of a regular expression, so a quote inside one cannot hide a `javascript:` URL after it; after a method call such as `o.if()` or `[1, 2].with(0, 3)` it is a division, so a `/` there cannot hide one either. gh verbs are allowed per group: a page with params may create and edit issues and pull requests (never from a body file), mark a pull request ready or read its checks, rerun, watch or cancel a run, and read releases, labels and workflows; `gh api`, `gh workflow run`, extensions, aliases, config, auth and secrets stay out. The refusal also says that a command without params is not limited. On the canvas, a copy of a locked group's member no longer joins that group, and a copy of a whole locked group stays locked. The size-cap timing test now checks that each shape scales linearly (a quarter of the cap against the cap) instead of a fixed one-second budget, so a slow machine cannot fail it. An approval now also covers which buttons were turned off, so a button a later release turns back on asks again; a page with every button on keeps its approval. A reserved source, button or param name (such as `path`) is now refused as reserved with a free name to try, instead of as malformed. When two chats save the same page, a save prepared from an older read now keeps the other chat's newer description, as it already kept a newer name. Review round 4 (2026-11-18) moved action placeholders to fail-closed slot tables (`renderer/shared/workspace-artifact-slots.ts`): a `{{param}}` may sit only where its program's (and subcommand's) table lists a slot, each slot has a rule (text, whole number, branch, gh target, workspace file), unknown options and verbs are refused, the old "after a literal `--`" exemption is gone (a leading `-` is allowed only as the separate-word value of options like `-m`, `-e` and `--body`), `--refmap`, git and jq file-reading options, `gh --jq`/`--template`/`--repo` and placeholder `git stash` verbs are refused. Each misplaced-placeholder refusal (quotes, command, subcommand or verb, joined text, joined option, after `+`/`@`) has its own message and fix, and a joined option is echoed back as a separate word (`-n {{count}}`). An action value may hold line breaks and tabs (it is one argument and never reaches a shell); any other control character is refused as "contains a control character". A workspace-file value is also checked by real path just before its command runs (`paths` on each argv command; the argv runner realpaths the value or its nearest existing ancestor against the folder's real path), so a symbolic link inside the folder cannot lead a read outside.
