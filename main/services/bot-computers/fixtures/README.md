# Lume output fixtures

Assumed shape until owner-Mac acceptance; replace with recorded output.

These files are what `lume` 0.6.1 is expected to print, written from its
Swift source at `lume-v0.6.1` (`src/VM/VMDetails.swift`,
`src/VM/VMDetailsPrinter.swift`, `src/Errors/Errors.swift`): `get` and `ls`
with `--format json` print a pretty-printed JSON array of `VMDetails` with
every optional key present (`null` when unset) and `/` escaped as `\/`.
Errors go to stderr as `Error: <description>`. The VM-limit text is
Virtualization.framework's and was not observed here.

On the owner Mac, record real output into these files and re-run
`npm run test:bot-computers`:

- `lume get <bot vm> --format json --storage <userData>/bot-computers/vms` while running and while stopped;
- `lume ls --format json --storage <userData>/bot-computers/vms` with the base, a running clone and an interrupted create;
- the detached-run log tail after starting a third macOS VM;
- `lume get missing-vm --storage …` stderr.

Replace the VNC password in recorded output before committing it.
