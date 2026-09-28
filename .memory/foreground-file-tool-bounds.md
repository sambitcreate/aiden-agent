# Foreground file-tool bounds — 2026-09-28

Scope: audit X03/X04/X05, based on a9baa4aa3027893e5455043083465c34b4c8b4ac.
All 36 then-open PRs rechecked with paginated file inventories (#85: 295 files,
#37: 209); none touched coding-tools.ts or its suite. Workspace/Git lanes are separate.

Parent read_file now opens/validates a regular descriptor, reads at most 200,001
bytes (including overflow probe), closes in finally, observes cancellation, and
omits an incomplete UTF-8 trailing sequence. Parent policy intentionally remains
broader than child policy: hidden metadata and credential names remain readable
except .env secrets; in-root links resolve, outside-root links fail. No subagent
credential/RE2 rules were transplanted into parent tools.

Parent list/glob/grep enumerate with opendir(bufferSize: 1), at most 10,000 entries
and 5 seconds per invocation. Over-budget directories are omitted rather than
allowing OS enumeration order to select a subset; prior complete-directory
results survive. List retains at most 500 results, glob 500, grep 200; collection
and output bounds have explicit notices (20,000 output chars). Grep skips hidden,
linked, dependency/build directories as before, reads at most 512,001 bytes per
file and 10 MiB total (including probes), and skips a growing oversized file.

JavaScript RegExp remains native JS, including lookbehind and backreferences,
inside a fixed-source owned worker. Model patterns are workerData, never code.
Glob parses bounded patterns with pinned minimatch 9.0.9 using Node fs.glob
options, then tracks glob segment positions and linked traversal states in the
worker. Host-side filesystem access remains bounded and confined. Traversal
rules are adapted from Node.js (MIT notice included). Native-glob differential fixtures cover ordinary patterns,
braces, extglobs, hidden paths, absolute paths, directory roots and symlinks.
Patterns have a new explicit 1,000-character ceiling. At most four matchers can
run concurrently; excess searches report busy. Cancellation, errors and deadlines
terminate and await the worker before releasing capacity; no persistent worker.
The small-search cost of worker startup is intentional and measured.

No Remote DTO, transcript/activity UI, native implementation or onboarding
capability changed. iOS/Android consumers were inspected: they use unchanged tool
names/labels, not filesystem scanning/matching internals. No plan status changed.
Evidence and repeatable commands: docs/performance/foreground-file-tools-2026-09-28/.
First independent Astra review found safe-link/brace and glob-dependent ..
compatibility gaps in the initial flattened-path matcher. Replaced that approach
with segment-state traversal and added differential fixtures before publication.
Re-review and hosted exact-head CI/bot review remain delivery gates.


PR #288 Pullfrog follow-up: derive each brace-expanded glob arm's root independently;
native differential tests cover mixed absolute/relative alternatives and reject an
outside-root arm before opening its directory. Foreground read/list/glob/grep now
share four operation owners. Caller abort and search deadline settle independently
of pending filesystem I/O; the original operation retains its slot through late
I/O and cleanup. An issued syscall itself is not cancellable. Late handles close
without further reads; failed cleanup quarantines admission. Root verification
awaits both started metadata requests even if one fails. Worker termination starts
on lifetime abort/deadline while its traversal callback may still be pending.
The stalled-I/O deadline result is an explicit notice without partial output.

Completion audit also caught the expanded-root offset using host separators even
though minimatch globParts are slash-normalized. Count normalized slashes so
Windows drive and UNC roots skip exactly their parsed prefix. Production-worker
VM fixtures use path.win32 and minimatch platform win32, covering slash/backslash
drive spelling, UNC, and mixed absolute/relative arms; prior code fails the fixture.


The assertion-based Electron smoke is registered as
`test:foreground-file-tools:electron` and required in the existing Desktop build
and diagnostics CI lane. Its Node runner bundles an isolated entry (Electron
explicitly external), owns workspace/profile fixtures, clears ELECTRON_RUN_AS_NODE,
and waits for child close after success/error/30s deadline/SIGINT/SIGTERM before
cleanup. CI policy coverage enforces this mandatory package-script invocation.

A later Pullfrog run found bare UNC share roots without a terminal slash. Consume
the complete platform root, and use an empty terminal segment for directory-self
matching when that consumes the whole pattern. Existing Windows worker fixtures
now cover drive roots, bare UNC shares with/without slash, and mixed relative arms.

Published Electron smoke receipts normalize the synthetic workspace prefix to
`<workspace>` while assertions retain real absolute paths. The counter receipts
already use repository-relative module paths and contain no author-local root.
