# Workspace artifacts

Workspace artifacts are small interactive pages that Aiden builds for a workspace and keeps in the **Artifacts** tab beside the chat. Each one shows status the person comes back to, for example the open pull requests, CI on main, a release checklist or a TODO board. Every chat in the workspace sees the same pages, and the data on them is read again each time the page refreshes.

They are a desktop feature on macOS and Linux. The CLI, Bots, Telegram and the iOS and Android apps do not have them.

## Asking for one

Ask in any chat in a workspace, for example "make me an artifact that shows the open PRs for this repo". Aiden uses the built-in **aiden-artifacts** skill and the `workspace_artifact` tool. It lists the workspace's pages first, so it updates an existing page rather than making a near-duplicate. The Artifacts tab opens on the new page beside the chat that made it.

Aiden builds a small working page first and checks it before adding more. Each save refreshes the page's sources once and draws the page with that data, the way the tab would. The result tells Aiden about:

- reads that come back empty, such as a misspelled field, `.length` on a list (pages use `len()`), or `<Each>` over an object;
- `run()` calls that name no action or pass the wrong number of values;
- sources the page never reads.

Aiden fixes those with another update. It doesn't press a button that changes something just to test it. The check only sees what the page draws with this data, so it also says what it couldn't cover: a source that didn't load, a list that was empty, an `<If>` branch hidden with this data, or a page too large to draw in full. Reads behind a guard, such as `<If test={$pulls.error}>` or `$x.note || "none"`, are not flagged. The check is a hint for Aiden, not a guarantee that the page is right.

The tab exists only once the workspace has a page. It appears in the tools launcher next to the terminal, files and browser, and it closes when the last page is deleted.

## How pages get their data

A page is written in Aiden UI Markup, the same component catalog that inline `render_ui` visuals use, and it declares named **sources**:

| Source | What it reads | Limits |
| --- | --- | --- |
| `shell` | A command run in the workspace folder that should only read, such as `gh pr list --json number,title,url`. Aiden asks for read-only commands but cannot enforce it, which is why Ask shows every command first | 30 seconds, 256 KiB of output |
| `file` | A workspace-relative file; links that leave the folder are refused | 30 seconds, 256 KiB |

Each source parses its output as `json`, `lines` or `text`, and the page reads it as `$name`. A source that has not loaded yet reads as `null`. A page has at most 8 sources, and a workspace has at most 20 pages.

Pages refresh when they are shown (unless the page turns that off), when the person presses **Refresh**, and, if the page asks for it, on an interval of at least 60 seconds while the tab is visible. The last data read is saved with the page, so it paints immediately and keeps showing the last good data when a refresh fails. The page header says which sources didn't load, and the page lists each failed source with its error, for example `gh: not logged in`.

## Buttons

Page buttons can:

- `sendPrompt("…")`: ask Aiden in the chat beside the page, after the same confirmation chip as inline visuals;
- `compose("…")`: put text in that chat's composer without sending it;
- `run("name", value…)`: run one of the page's declared **actions**, a shell command template such as `gh pr merge {{number}} --squash`;
- `openUrl`, `copy` and `setState`, as in inline visuals.

Action values from the page never become shell syntax. Each `{{param}}` must be its own unquoted argument in the template: not inside quotes, `$(…)`, a heredoc or a comment, not the command itself, and not an argument a command runs as code or as a program: after `eval`, `sudo`, `env` or `xargs`, the script of `sh -c` or `python -c`, or an `awk` or `sed` program. Redirections, assignments and comments before a command do not hide it. Text values cannot appear inside `[[ ]]`, `(( ))`, `let`, `read`, `declare` or `printf -v`, where bash evaluates names and arithmetic; number values can. The list of programs that run code covers common ones, not every program, so under Ask each press still shows the exact command before it runs. The value is bound to a read-only variable and passed as one quoted argument, so it is exactly what the confirmation showed. Values may not start with `-`, number values may not be negative, and control or invisible characters are refused. The command that runs is always the one saved with the page, never text from the page itself. A page has at most 16 actions, each with a 2-minute limit.

Aiden can also run a page's action when you ask it in chat, for example "merge PR 12" with a pull request board open. It uses the `workspace_artifact` tool's `run` operation, which goes through the same checks as a button press:

- Under Ask, the approval card shows the exact command with its values, and nothing runs until you allow it. Allowing covers that one command only: if the page or the values change before it runs, it doesn't run.
- A page whose commands you haven't allowed yet doesn't run, and no card is shown; allow the page in the Artifacts tab first.
- Under Full access the action runs without a card, as a button press would. Aiden's skill tells it to run actions only when you ask and never to press buttons to test a page, but under Full that is guidance, not something the app enforces.
- Without a folder or with workspace access off, nothing runs.

A failed command fails the tool call with its output, and the page refreshes afterwards either way.

## Access

Pages follow the workspace's access setting, the same way chats do:

- **No access**: nothing runs. The page shows its last saved data and says why it is not live.
- **Ask**: when Aiden creates or changes a page, the approval card lists every command it can run. Allowing it approves exactly that set of commands, and any later change to them needs approval again. The person can also review and allow a page from the tab, which reads its sources at once. Each button press shows the exact command and waits for **Run**. File sources run without approval, because chats under Ask read workspace files without asking.
- **Full access**: sources and buttons run without asking.

Changing a workspace's access cancels any refresh or button already running. Commands run with the same environment as `run_command`, and Aiden's own secrets are withheld. Like `run_command`, a source or button command that leaves a background job holding its output has that job stopped 1 second after the command exits (a job started with `setsid` or as a daemon leaves the command's process group and is not stopped); redirect a job's output (`> file 2>&1 &`) if it should keep running.

## Managing pages

The page header has a switcher between pages, the time of the last refresh, **Refresh**, and a menu with **Ask Aiden to change this**, **Rename**, **Earlier versions** and **Delete**. Delete asks for confirmation first. Aiden deletes a page only when the person asks, and its delete always shows an approval card.

Pages and their saved data are stored on the device under Aiden's user data folder (`workspace-artifacts/`), not in the repository, and they are not part of portable settings. Removing a workspace removes its pages.

## Earlier versions

Aiden keeps the last 5 versions of each page (`WORKSPACE_ARTIFACT_LIMITS.history`), so a bad update can be undone. Every update by Aiden (and every restore) keeps the version it replaced; renaming a page, allowing its commands and the page's own state do not make a version.

- **Earlier versions…** in the page menu lists them newest first, with when each was replaced and its name at the time if it differed. **Restore** makes that version the page again as a new version, so a restore can itself be undone the same way.
- You can also ask Aiden, for example "undo the last change to the PR board". It uses the `workspace_artifact` tool's `restore` operation, and `list` shows each page's `earlierRevisions`.
- A restore keeps the page's current name. It also brings back that version's page state (checked boxes, the chosen tab and similar), because the state is saved with the page. Changes to the state alone are not versions.
- Under Ask, a version whose commands differ from the ones you allowed needs allowing again: the page menu marks it "Different commands — needs allowing again" (including while the current page is itself still waiting to be allowed), and Aiden's restore shows an approval card listing the commands, like an update. A version with the same commands as the allowed ones restores without asking.
- In a workspace without folder access, Aiden can't restore a version that reads files or runs commands. **Restore** in the page menu still saves it, but nothing runs until the workspace has access.
- After a restore from the page menu, the page re-reads its sources if it is allowed to.

Earlier versions are stored on the device next to the pages (`<workspaceId>.history.json`), never with an approval. They are deleted with the page, and with the workspace, including when a delete lands while an update is still saving the version it replaced. If the history file is damaged it is replaced rather than repaired, and if it can't be written the page update or delete still goes through; the pages themselves are unaffected.

## For developers

- Shared contract and parsers: `renderer/shared/workspace-artifacts.ts`.
- Store, tool, runner, page check and skill: `main/services/workspace-artifacts/`. The page check (`check.ts`) uses the evaluator's `onRead` hook, which only the check sets, to record each `$name` and member read the page actually takes.
- IPC: `workspaces:artifacts:list`, `rename`, `delete`, `saveState`, `approve`, `refresh`, `run`, `history` and `restore` (which never records an approval), plus the `workspaces:artifacts-changed` notification (`main/handlers/workspace-artifacts.ts`).
- Tab: `renderer/components/artifacts-panel.tsx`, wired into the Environment panel.
- Tests: `npm run test:workspace-artifacts`.
- Design and decisions: [Workspace Artifacts plan](plans/workspace-artifacts-plan.md).
