# Workspace artifacts

Workspace artifacts are small interactive pages that Aiden builds for a workspace and keeps in the **Artifacts** tab beside the chat. Each one shows status the person comes back to, for example the open pull requests, CI on main, a release checklist or a TODO board. Every chat in the workspace sees the same pages, and the data on them is read again each time the page refreshes.

They are a desktop feature on macOS and Linux. The CLI, Bots, Telegram and the iOS and Android apps do not have them.

## Asking for one

Ask in any chat in a workspace, for example "make me an artifact that shows the open PRs for this repo". Aiden uses the built-in **aiden-artifacts** skill and the `workspace_artifact` tool. It lists the workspace's pages first, so it updates an existing page rather than making a near-duplicate. The Artifacts tab opens on the new page beside the chat that made it.

The tab exists only once the workspace has a page. It appears in the tools launcher next to the terminal, files and browser, and it closes when the last page is deleted.

## How pages get their data

A page is written in Aiden UI Markup, the same component catalog that inline `render_ui` visuals use, and it declares named **sources**:

| Source | What it reads | Limits |
| --- | --- | --- |
| `shell` | A command run in the workspace folder that should only read, such as `gh pr list --json number,title,url`. Aiden asks for read-only commands but cannot enforce it, which is why Ask shows every command first | 30 seconds, 256 KiB of output |
| `file` | A workspace-relative text file; credential paths, hard links and links outside the folder are refused | 30 seconds, 256 KiB |

Each source parses its output as `json`, `lines` or `text`, and the page reads it as `$name`. A source that has not loaded yet reads as `null`. A page has at most 8 sources, and a workspace has at most 20 pages.

Pages refresh when they are shown (unless the page turns that off), when the person presses **Refresh**, and, if the page asks for it, on an interval of at least 60 seconds while the tab is visible. The last data read is saved with the page, so it paints immediately and keeps showing the last good data when an ordinary refresh fails. A credential-policy denial erases that source’s cached data before it can be returned or displayed. After this security upgrade, older file-source caches are cleared once and need a refresh. The page header says which sources didn't load, and the page lists each failed source with its error, for example `gh: not logged in`.

## Buttons

Page buttons can:

- `sendPrompt("…")`: ask Aiden in the chat beside the page, after the same confirmation chip as inline visuals;
- `compose("…")`: put text in that chat's composer without sending it;
- `run("name", value…)`: run one of the page's declared **actions**, a shell command template such as `gh pr merge {{number}} --squash`;
- `openUrl`, `copy` and `setState`, as in inline visuals.

Action values from the page never become shell syntax. Each `{{param}}` must be its own unquoted argument in the template: not inside quotes, `$(…)`, a heredoc or a comment, not the command itself, and not an argument a command runs as code or as a program: after `eval`, `sudo`, `env` or `xargs`, the script of `sh -c` or `python -c`, or an `awk` or `sed` program. Redirections, assignments and comments before a command do not hide it. Text values cannot appear inside `[[ ]]`, `(( ))`, `let`, `read`, `declare` or `printf -v`, where bash evaluates names and arithmetic; number values can. The list of programs that run code covers common ones, not every program, so under Ask each press still shows the exact command before it runs. The value is bound to a read-only variable and passed as one quoted argument, so it is exactly what the confirmation showed. Values may not start with `-`, number values may not be negative, and control or invisible characters are refused. The command that runs is always the one saved with the page, never text from the page itself. A page has at most 16 actions, each with a 2-minute limit.

## Access

Pages follow the workspace's access setting, the same way chats do:

- **No access**: nothing runs. The page shows its last saved data and says why it is not live.
- **Ask**: when Aiden creates or changes a page, the approval card lists every command it can run. Allowing it approves exactly that set of commands, and any later change to them needs approval again. The person can also review and allow a page from the tab, which reads its sources at once. Each button press shows the exact command and waits for **Run**. File sources run without approval, subject to the model file policy. `.env` except `.env.example`, protected credential names and canonical aliases to them are denied at creation/update and again at read. Human Files-panel editing retains its own access contract.
- **Full access**: sources and buttons run without asking.

Changing a workspace's access cancels any refresh or button already running. Commands run with the same environment as `run_command`, and Aiden's own secrets are withheld. Like `run_command`, a source or button command that leaves a background job holding its output has that job stopped 1 second after the command exits (a job started with `setsid` or as a daemon leaves the command's process group and is not stopped); redirect a job's output (`> file 2>&1 &`) if it should keep running.

## Managing pages

The page header has a switcher between pages, the time of the last refresh, **Refresh**, and a menu with **Ask Aiden to change this**, **Rename** and **Delete**. Delete asks for confirmation first. Aiden deletes a page only when the person asks, and its delete always shows an approval card.

Pages and their saved data are stored on the device under Aiden's user data folder (`workspace-artifacts/`), not in the repository, and they are not part of portable settings. Removing a workspace removes its pages.

## For developers

- Shared contract and parsers: `renderer/shared/workspace-artifacts.ts`.
- Confined reads: macOS uses the packaged descriptor-relative worktree file helper; Linux uses Node directory descriptors through `/proc/self/fd`, with pinned root/file identities, no-follow traversal and bounded reads. Linux requires procfs descriptor access and fails closed without it; it does not depend on the macOS helper.
- Store, tool, runner and skill: `main/services/workspace-artifacts/`.
- IPC: `workspaces:artifacts:list`, `rename`, `delete`, `saveState`, `approve`, `refresh` and `run`, plus the `workspaces:artifacts-changed` notification (`main/handlers/workspace-artifacts.ts`).
- Tab: `renderer/components/artifacts-panel.tsx`, wired into the Environment panel.
- Tests: `npm run test:workspace-artifacts`.
- Design and decisions: [Workspace Artifacts plan](plans/workspace-artifacts-plan.md).
