# Terminal startup lifecycle — 2026-09-19

- Baseline: `5cc831a17aa8971fb5b89c7dd9278a6ec4022beb`; branch `feature/upgrade-08-terminal`.
- `TerminalService.create` previously spawned before awaiting history, so output/exit events could be lost during disk I/O and read failure could leave an unowned shell. Awaiting an otherwise synchronous spawn helper also allowed simultaneous requests to exceed the eight-session cap.
- Load history before final access revalidation, then keep cap admission, shell spawn, session ownership, and listener installation synchronous. Cancellation during history restore now prevents spawn.
- Existing `main/services/terminal.test.ts` is already registered in normal tests and `test:terminal:coverage`. New regressions reproduce startup output loss, missed immediate exit, failed-history leak, restore-time cancellation, and concurrent session-limit bypass on baseline.
- Source learning only; no reference code copied. OpenCode v2 `packages/opencode/src/pty/index.ts` at `7a6ce05d0939826aa6c8e1c481489a713b2d633f` installs active ownership and listeners directly after spawn. Waku `src/terminal.rs` at `6d433e875d57091906ec0770d8bb9ffc9aa29b83` prepares terminal state before spawning its event loop. OMP `crates/pi-natives/src/pty.rs` at `f97fa5c95010b62ac34c7357f9a1cae6975e12d6` checks cancellation before acquiring a child and documents post-spawn cleanup ownership. Licenses inspected: OpenCode/OMP MIT, Waku GPL-3.0.
- Local validation: terminal coverage (33 tests; service lines 96.64%, branches 85.71%, functions 94.87%), terminal history (17), Ghostty/drawer (15), full type-check and lint pass.
- No new UI, durable feature, IPC/shared-server contract, or native-client behavior; onboarding and mobile changes are unnecessary. No Electron build, rendered UI, packaged Mac, or physical-device acceptance performed. Existing terminal plan status stays implemented with packaged acceptance pending.

## 2026-09-21: macOS GUI command PATH

A production chat reported `gh` missing from the parent agent's `run_command` PATH, despite installation in `~/.local/bin` and `/opt/homebrew/bin`. The tool uses a non-login shell with Electron's inherited environment, which can be shorter than interactive zsh's PATH. The PTY and Git service also inherited that environment; Git's `!gh auth git-credential` helper needs `gh` on PATH during push.

The shared `agentCommandEnvironment` appends standard macOS CLI directories when absent while preserving inherited lookup precedence and empty PATH components. It is used by parent agent commands, user terminals, and Git service commands. The deliberately minimal subagent shell runner remains separate. Registered coding-tool and terminal tests cover the short GUI PATH and CLI discovery. Shell startup files are not sourced, so arbitrary custom PATH entries are outside this fix.
