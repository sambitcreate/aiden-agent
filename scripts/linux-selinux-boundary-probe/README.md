# Disposable Fedora SELinux boundary probe

This is a synthetic prerequisite experiment, not an Aiden launcher, identity
check, broker, or Computer Use implementation. It changes only dedicated fixture
types/resources in an explicitly chosen disposable Fedora VM. Never run it on a
user workstation or as an ordinary development/test prerequisite.

## Requirements and execution

Use an independently booted Fedora guest with SELinux Enforcing and auditd.
Required installed tools: GCC, make, selinux-policy-devel, policycoreutils,
setools-console, Node.js, systemd, and util-linux. The tested Fedora44 guest uses
SELinux userspace3.11. Its installation supports CIL `deny` through `semodule`.
Do not use `setenforce`, `semodule -DB`, disabled neverallow checks, policy
booleans, rebooting, or changes to the graphical session for this experiment.

Copy this directory to a new root-owned directory inside the disposable VM,
review its contents, and invoke explicitly:

```sh
sudo bash /var/tmp/reviewed-probe/run.sh /var/tmp/new-boundary-evidence
```

The evidence directory must not exist. The runner refuses existing fixture
resources/user/modules. It creates a dedicated system user with no login shell,
home, or sudo membership. Holder and attacker run under that same non-root UID.
The root-owned service launches the root-owned holder executable. The attacker
executable stays in the caller's verified `unconfined_t` domain. Only synthetic
test data is used; no Aiden profile, credentials, or history is read.

Every exit runs cleanup: stop the unit, remove the unit/executables/runtime
directory/build directory, remove both policy modules, and delete the test user.
Each cleanup action is attempted even if an earlier one fails; any failure makes
the final exit nonzero. Both unauthorized execution attempts have a two-second
timeout with a one-second kill escalation, so a regression cannot hold cleanup
behind the native fixture's service loop.
Evidence is retained with root-only directory access. Check `cleanup.log` before
claiming success. After a host crash, inspect and remove only these fixture names
before retrying: `aiden-selinux-boundary-probe.service`,
`/usr/libexec/aiden-selinux-boundary-probe`, `/run/aiden-selinux-boundary-probe`,
user `aiden-boundary-probe`, modules `aiden_boundary_probe_deny` and
`aiden_boundary_probe`. Remove the deny module before the base module.

## What is measured

1. Install a small base module defining a daemon domain and synthetic data type.
   Preserve stock unconfined access to private objects: observe Fedora's
   existing attribute-derived access instead. The delegation fixture additionally
   authorizes only its outgoing transition and dedicated report output. Check the holder domain and same UID.
2. Verify file read, `/proc/PID/comm` read, and private Unix socket connection
   succeed before installing the deny overlay. Also record proc-fd, ptrace, and
   pidfd_getfd behavior. Holder is deliberately dumpable; no Yama setting changes.
3. Install target-scoped CIL denies. Save the actual loaded binary policy before
   and after; `sesearch` must show the selected effective allows disappearing.
   The selected syscalls must now fail with EACCES/EPERM.
4. Require current-run, exact attacker PID, enforcing AVC records for file and
   socket denials. Read only appended audit records and retain only fixture AVC
   lines. Audit rotation fails validation instead of silently mixing receipts.
5. Require direct execution and `runcon` execution to fail with cannot-invoke
   status126. The base policy makes the requested unconfined-role context
   structurally valid; an invalid-context error is not counted. The effective
   incoming transition sources must be only `init_t`, with no dynamic transition
   allows. Restart the system service successfully under the deny overlay.
   Native holder code verifies its own SELinux context and non-root UID before
   creating its ready socket, because the overlay also blocks unconfined root's
   `/proc` reads. Root is the trusted provisioner, not the attacker model.
6. Intentionally delegate a read-only synthetic file descriptor from a trusted
   service to the same-UID unconfined receiver. SCM_RIGHTS uses an outward
   connection to the receiver's socket, avoiding the denied inbound connection.
   The baseline must read the exact token; under the overlay `recvmsg` succeeds
   with `MSG_CTRUNC` and no descriptor. A second service forks with descriptor10,
   explicitly changes only the child to `system_u:system_r:unconfined_t:s0`,
   verifies that context, then reads the inherited descriptor. Baseline token
   reads must become EACCES/EPERM under the overlay. Both cases require an exact
   receiver PID/context, private-file path, enforcing `fd { use }` AVC, and the
   loaded stock `unconfined_t -> aiden_boundary_probe_t:fd use` allow disappearing.
   Native alarm limits are six seconds (four in the fork child); the receiver
   wrapper allows eight seconds with one-second kill escalation. Socket readiness
   allows four seconds. Transient services have start/run/stop limits of 3/8/2
   seconds, with a 12-second wrapper and two-second kill escalation. Cleanup
   stops any outstanding delegation unit and reaps the receiver before UID removal.
7. Remove the overlay and require the original file/proc/socket and descriptor operations to
   succeed again. Then cleanup removes the base fixture too.

Fedora's stock `dontaudit unconfined_usertype domain:file { ... open read ... }`
suppresses the `/proc/PID/comm` AVC. Its result therefore explicitly records
before/after behavior plus effective policy and dontaudit evidence, not an AVC
claim. Proc-fd remains unproven without complete audit evidence. Ptrace/pidfd
are counted separately only when their baseline succeeded and a matching ptrace
AVC plus effective permission removal exists. A Yama/DAC/unsupported-syscall
failure in the baseline is reported as not proven, never as a policy success.

## Evidence limits

Descriptor evidence covers a read-only regular file transferred through
SCM_RIGHTS or inherited across fork followed by a fixture-authorized outgoing
setcon. It does not cover inherited descriptors across exec, arbitrary dynamic
setcon, stolen socket/pipe endpoint operations, executable relabeling, all possible source domains, release signatures, immutable payloads,
Electron role separation, process lifetime binding, or compositor capture/input.
An initial outgoing exec experiment on Fedora44 reached the target domain but
then failed before receiver main: the coarse creator-domain `fd/use` deny also
blocked use of the receiver executable opened during exec, causing SIGSEGV.
That failure is not counted as descriptor protection evidence. This tradeoff
means these results do not establish a usable Electron child/loader policy;
protected channel object permissions require separate experiments.

The policy is intentionally a small test, not a security policy suitable for
Aiden. A successful result always reports `releaseIdentityEstablished: false`
and `computerUseEnabled: false`.

The host-independent verifier tests run with:

```sh
node --test scripts/linux-selinux-boundary-probe/verify.test.mjs scripts/linux-selinux-boundary-probe/cleanup.test.mjs
```

## Primary references

- [CIL deny semantics](https://github.com/SELinuxProject/selinux/blob/main/secilc/docs/cil_access_vector_rules.md#deny): subtraction happens before neverallow checking.
- [CIL type transitions](https://github.com/SELinuxProject/selinux/blob/main/secilc/docs/cil_type_statements.md#typetransition): a transition declaration also needs permission.
- [Fedora domain policy](https://github.com/fedora-selinux/selinux-policy/blob/rawhide/policy/modules/kernel/domain.te): inspect the installed binary policy as authoritative for each run.
- [pidfd_getfd](https://man7.org/linux/man-pages/man2/pidfd_getfd.2.html) and [/proc/PID/fd](https://man7.org/linux/man-pages/man5/proc_pid_fd.5.html): different ptrace access checks apply.
