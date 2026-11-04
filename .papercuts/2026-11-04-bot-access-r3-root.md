# Access request round 3 integration

- Same-key dismissal failed before reaching the issue port after a transient error. A real ledger test now covers retry and cached success; an ordinary stop action keeps its original cached rejection.
- A real store/ledger case showed unrelated pending transcript status blocking an access dismissal before it could claim. The corrected action settles durably, can retry as not_open while transcript writes still fail, and repairs status after recovery.
- The reported phone open_settings retry path is unreachable. The strict Remote parser excludes desktop-only actions. An actual call with section access returns 400 and never reaches the port; keep that boundary instead of widening the protocol.

- Full runtime validation caught ordinary issue resolve broadcasting twice after the access early-notify change. Kept early notification access-specific, preserved the existing ordinary sidebar contract, and retained the failing suite evidence before rerun.
