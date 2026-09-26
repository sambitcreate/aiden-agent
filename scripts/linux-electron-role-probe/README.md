# Disposable Electron role-transition probe

This Fedora 44 / GNOME Wayland experiment grants no Computer Use authority. It
runs a synthetic Electron 43.1.1 application and checks a **role-boundary
candidate**, not release identity, production containment, or first-instruction
identity. Never install these deliberately broad domains on a production host.

## Run and prerequisites

Use the dedicated Fedora ARM64 VM with SELinux enforcing, active GNOME user
`fedora` UID 1000 and `/run/user/1000/wayland-0`, Node.js, Python 3 with pidfds,
SELinux development tools, setools, systemd, util-linux, GCC, and Fedora
`nodejs22-devel` headers at `/usr/include/node`. The addon uses stable N-API 8
and is compiled directly with GCC; no package build/install scripts run. The operator-provided
Electron distribution must already exist at `/var/tmp/aiden-electron43/dist`.
The harness rejects symlinks and special files and copies it to a new root-owned
`/usr/libexec/aiden-electron-role-probe` directory. This copying and hashing do
not verify a signed release or protect against an actively racing source writer;
prepare the input in the isolated guest without concurrent modification.

```sh
sudo bash scripts/linux-electron-role-probe/run.sh /var/tmp/new-electron-role-evidence
node --test scripts/linux-electron-role-probe/*.test.mjs
```

The evidence path must be new and absolute. Existing fixture modules, either unit,
installation, or runtime directory cause refusal. Do not run concurrently with
another invocation. No SELinux booleans, enforcing state, global dontaudit
settings, or Electron sandbox settings are relaxed.

## What the experiment checks

- A root-managed system unit in `init_t` executes the fixed labelled Electron
  binary as UID 1000 into `aiden_electron_role_probe_main_t`.
- Main executing that **same inode label** transitions to
  `aiden_electron_role_probe_child_t`. Explicit child entrypoint permission and
  `process2 nnp_transition` are required on this Fedora policy. Chromium sets
  NoNewPrivs before zygote exec; without the NNP permission, SELinux can retain
  the old SID. An earlier diagnostic deliberately omitted the ordinary-file
  execute restriction and the verifier rejected zygotes retaining main's role.
- Main has no effective `file execute_no_trans` permission across any policy
  type. Ordinary commands labelled `bin_t` or `shell_exec_t` transition to child;
  other ordinary-file exec paths refuse. The fixture exercises `/usr/bin/true`
  and checks the context emitted by a shell command. This is not a blanket
  claim about every executable object: the tested kernel reports
  `memfd_class=0`, and separate memfd-class/unknown-permission behavior remains
  a production policy gate.
- A visible sandboxed BrowserWindow computes a DOM result, the network utility
  fetches a loopback-only synthetic HTTP response, and a Node utility computes
  and reports its context. No model, driver, or external service is contacted.
- Root independently collects unit-cgroup members, main descendants, and all
  live fixture-domain processes. Main must be present, the Node worker PID must
  match its root observation, and zygote/GPU/renderer/network/Node categories
  must use the expected Electron executable. All observed non-main processes
  must have the child type and all four UIDs must be 1000. Renderer Seccomp=2 and
  NoNewPrivs=1 are required. Command-line categories are diagnostics, never
  authentication inputs.
- Same-UID direct execution and a structurally valid forged main `runcon` both
  must fail with exit 126 and Permission denied. Timeout/spawn errors do not
  pass. An effective policy query must show no unconfined-to-main transition.

## Cleanup and evidence

The EXIT/INT/TERM path attempts every cleanup step even after a failure: stop
both units; drain fixture-domain processes through pidfds; remove both units,
installation, profile, IPC runtime directory, and build directory; remove deny then base modules; and
record final enforcement/module state and `cleanup-status.txt`. Inspect status
0 and `Enforcing` before accepting cleanup. Evidence remains at the requested
path. Journal/audit records are diagnostics; a missing AVC is not proof of a
negative test. Verifier and cleanup fault tests cover missing roles, wrong
contexts/UIDs, sandbox changes, incorrect negative outcomes, remaining allows,
and cleanup failures.

GNOME may move an application into a user scope: an earlier cgroup-only snapshot
missed the browser and Node utility. The combined observer and domain-scoped
pidfd cleanup cover this disposable run, but polling and cleanup are **not** a
production containment or revocation solution. Future release supervision must
prevent or correctly handle migration and escaped/orphaned descendants.

## Deliberate limits

Both fixture domains use Fedora's broad unconfined interfaces to isolate role
transition feasibility from the much larger desktop-access policy problem.
They do not establish hostile same-UID memory, ptrace, or general socket and
descriptor isolation beyond the specific SCM_RIGHTS cells below. Necessary Chromium inherited channels are not denied. Writable
runtime data, unsigned interpreted payloads, dynamic libraries, JIT, and user
configuration remain outside this proof. No broker or Cua process is started.

A native fork inherits main's label until exec; snapshots cannot prove that no
child instruction ran in main's domain. Auditing actual trusted-main fork paths
and enforcing code-loading constraints remain essential. Successful ordinary
exec transitions therefore do not authorize production admission.

Relevant primary source: Linux 6.19
[`selinux_bprm_creds_for_exec` and NNP transition handling](https://github.com/torvalds/linux/blob/v6.19/security/selinux/hooks.c#L2182-L2425).

## Actual Electron protected SCM_RIGHTS experiment

`ipc-server.c` runs as UID 1000 in a separate fixed systemd service and
`aiden_electron_role_probe_sender_t`. A single server process creates all four
socketpairs, so generic and protected descriptors have the same FD creator SID.
For each pair, the protected case uses `/proc/self/attr/sockcreate` to select
`aiden_electron_role_probe_protected_t`, then resets socket creation context.
The server reports kernel socket labels and peer PID/context, sends a synthetic
token, transfers one endpoint, and verifies an ACK on that endpoint.

`ipc-addon.c` is loaded by the **actual Electron main and actual Node utility**.
Its synchronous N-API call performs `recvmsg(MSG_CMSG_CLOEXEC)` itself; no
standalone surrogate receives descriptors for Electron. It reads its own native
PID/context, server credentials/context, and received socket's kernel label.
A channel boolean selects generic/protected test data; callers cannot supply an
authorizing role. Connect/read/write/message waits use monotonic deadlines and
nonblocking sockets; sends use MSG_NOSIGNAL. The server also has a total alarm
and systemd runtime limit.

The overlay subtracts protected socket **read/write** from every domain except
main and sender. Main's protected access is explicitly allowed. Both main and
child retain creator `fd use`, generic read/write, and socket metadata `getopt`
for label observation. No blanket FD denial can substitute for the object rule.

The verifier requires all four cells from the same server PID:

| Receiver | Generic endpoint | Protected endpoint |
| --- | --- | --- |
| Electron main | Token/ACK roundtrip | Token/ACK roundtrip |
| Node utility child | Token/ACK roundtrip | No received FD, MSG_CTRUNC, no token/ACK |

It cross-checks native receiver PIDs with the existing root process receipt,
checks sender/receiver socket labels and contexts, requires effective socket
allows/denials and retained creator FD use, and matches an enforcing
`unix_stream_socket` read/write AVC to the exact Node utility PID and protected
object context. Audit evidence contains only bytes appended during this run;
rotation or truncation fails acceptance. Sender success status and all four
rows are mandatory. Existing renderer/network/shell and process-role tests
remain mandatory. Cleanup includes the sender domain in the pidfd drain.

This demonstrates selective SCM_RIGHTS endpoint omission in the actual tested
Electron roles. It does not prove inherited-descriptor revocation, pipe
isolation, peer-current-holder authentication, protection against a compromised
main, or production admission. SO_PEERCRED/SO_PEERSEC here describe the fixed
fixture's connections; they are not presented as a general transferable-socket
holder credential. No Cua process or automation capability is enabled.
