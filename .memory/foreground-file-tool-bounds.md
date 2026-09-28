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
Glob uses Node matchesGlob with native-compatible directory and explicit linked
prefix handling. Native-glob differential fixtures cover ordinary patterns,
braces, extglobs, hidden paths, absolute paths, directory roots and symlinks.
Patterns have a new explicit 1,000-character ceiling. At most four matchers can
run concurrently; excess searches report busy. Cancellation, errors and deadlines
terminate and await the worker before releasing capacity; no persistent worker.
The small-search cost of worker startup is intentional and measured.

No Remote DTO, transcript/activity UI, native implementation or onboarding
capability changed. iOS/Android consumers were inspected: they use unchanged tool
names/labels, not filesystem scanning/matching internals. No plan status changed.
Evidence and repeatable commands: docs/performance/foreground-file-tools-2026-09-28/.
Independent Astra review and hosted exact-head CI/bot review are delivery gates.
