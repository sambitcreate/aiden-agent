# CLI workspace tools and generation watchdog

Issues #536 and #537. Daemon workspace chats now register the shared `buildCodingTools` set through the authority extension instead of Pi's built-ins. Full scheduled inference uses that same set; read-only schedules retain only read_file/list_dir/glob/grep. Bundled native file mutation uses AIDEN_CLI_ENTRY/native/aiden-subagent-file-mutator. Approval summaries and protected-config guards use the canonical names, with legacy hook-name normalization retained for old journals.

The shared file tools enforce workspace path and secret-read checks. run_command remains a bounded OS-user shell with a workspace cwd and filtered environment, not a filesystem sandbox. This patch addresses the proposed wiring but leaves #536 open for a decision about shell confinement; #537's fixed five-minute wall-clock abort is replaced.

Both daemon chat and scheduled inference use a five-minute inactivity watchdog refreshed by message_update and tool_execution_start/update/end, with a separate six-hour absolute ceiling. The watchdog is disposed on all exits. Approval expiry and scheduled tool/turn/output budgets are unchanged. Fake-model integration tests cover outside/.env refusal, permitted reads and native writes/edits, a 320-second daemon stream and a 340-second scheduled tool loop. Focused watchdog tests cover silence, each activity event, ceiling and disposal.

Local validation: CLI build and type-check passed; full CLI suite passed 314 with three util-linux TTY skips on macOS. The 44-case daemon lifecycle/approval suite also passed separately. Exact-head CI is recorded in the PR. The old interactive TUI no longer exists; the CLI remains serve-only.
