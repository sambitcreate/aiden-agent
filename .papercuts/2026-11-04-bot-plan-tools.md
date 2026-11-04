# Task5 papercuts

- Prep: BotToolCall originally exposed only write-or-read memo and raw optional request IDs. Task4 added readMemo and runInputIds so replay preserves captured authorization and unnamed inputs keep host-stable ownership.
- The A port contract says announceWaiting must not throw, but the real courier throws when delivery authority is missing. Treat that as unavailable before creating a waiter.
- Task5's new test file is intentionally unregistered here because root owns package.json and the CI registry.
- Initial integration fixtures needed B's canonical choice order and A's recoverable target effect. Their real parsers correctly refused incomplete fixtures; both fixtures were completed without weakening the assertions.
- A real-ledger regression showed an expired replay incorrectly saying nobody approved a previously approved plan. Preserve a host approval receipt and report ended, including after full display history is gone.
- A barrier test found concurrent first executions could attach changed arguments after losing the first memo write. Verify the returned memo identity in both read and first-write paths before requesting any card.
- The project's TypeScript library target does not include ErrorOptions. Attach the internal grant failure cause with Object.assign while keeping the actionable model-facing message.
