# Disposable typed UNIX socket delegation probe

This synthetic prerequisite measures a distinct SELinux socket object label. It
is not an Aiden broker, release identity check, Electron role policy, or Computer
Use implementation. Run only in an explicitly selected disposable Fedora VM
with its own enforcing SELinux kernel. No application profiles or credentials
are used. The ordinary test suite runs only the host-independent verifier and
cleanup fault tests; it never installs policy.

## Run and cleanup

Required guest tools: GCC, make, selinux-policy-devel, policycoreutils, secilc,
setools-console, Node.js, auditd, systemd, util-linux, coreutils. The native run
was accepted on Fedora44 ARM64, kernel6.19.10, SELinux userspace3.11. Copy this
directory into a new root-owned guest directory, inspect it, and explicitly run:

```sh
sudo bash /var/tmp/reviewed-ipc-probe/run.sh /var/tmp/new-ipc-evidence
```

The runner rejects an existing evidence directory, fixture user, installation,
runtime directory, or policy module. It creates root-owned sender/receiver
executables and a dedicated nonroot system user with no home, login shell, or
sudo membership. The trusted sender is launched only by a root-created transient
system service, and checks its `aiden_ipc_sender_t` context before creating any
socketpair. Receiver code checks `unconfined_t`; both sides report their UID,
PID, context, channel type, and protocol outcome.

Both native processes have six-second alarms. Receiver wrapper allows eight
seconds plus a one-second kill escalation; socket readiness has a four-second
limit. Services have start/run/stop limits of 3/8/2 seconds, with a 12-second
wrapper and two-second kill escalation. Every exit attempts outstanding service
stop, receiver reap, fixture file removal, both policy removals, and user deletion.
Cleanup continues after individual failures and returns nonzero for any failure.
Evidence stays in a root-only directory; require `cleanup.log` ending in `exit=0`.

After a crash, inspect only the dedicated resources: transient units matching
`aiden-ipc-delegation-*`, `/usr/libexec/aiden-protected-ipc-probe`,
`/run/aiden-protected-ipc-probe`, user `aiden-protected-ipc-probe`, and modules
`aiden_ipc_probe_deny` then `aiden_ipc_probe`. Do not change enforcing mode, global
booleans, audit suppression, neverallow checks, or GNOME/session configuration.

## What the native evidence establishes

1. Generic and protected channels are separate fresh `SOCK_STREAM` socketpairs.
   Generic sockets retain the creator's `aiden_ipc_sender_t` socket SID. For the
   protected pair, the trusted sender writes the dedicated
   `system_u:object_r:aiden_ipc_protected_socket_t:s0` creation context to
   `/proc/self/attr/sockcreate`, creates both endpoints, and immediately resets
   that setting. `SO_PEERSEC` reports the peer socket's SID; both endpoints were
   created under the same setting, so this validates the pair's socket label.
2. Socket creation does not change the task's domain. Both file descriptors are
   created by the same verified sender domain. The policy explicitly grants and
   retains `unconfined_t -> aiden_ipc_sender_t:fd use` throughout the experiment.
   SO_PEERSEC is evidence of the socket object SID, not the file creator SID.
3. The sender intentionally connects outward to an ordinary receiver listener
   and transfers one endpoint with SCM_RIGHTS. Baseline requires the receiver to
   read an exact synthetic token and write an exact ACK through that endpoint;
   the sender must receive that ACK. Thus both channel directions work.
4. The overlay subtracts only unconfined-domain `read/write` access to
   `aiden_ipc_protected_socket_t:unix_stream_socket`. It never removes `fd/use`.
   Generic transfer and full roundtrip must still work under the overlay.
   Protected `recvmsg` must complete with its payload, `MSG_CTRUNC`, and no
   descriptor. This is descriptor omission at receive, not a fabricated read
   error, timeout, failed connection, or process crash.
5. The verifier requires both protected read/write allows absent from the loaded
   binary policy, generic read/write and creator fd/use allows still present,
   and a current-run enforcing AVC for the exact receiver PID/context and
   protected socket type/class. Audit rotation or missing evidence fails.
6. Removing the overlay must restore protected transfer and bidirectional data
   while generic data remains functional. The loaded restored policy is also
   queried. Cleanup then removes the base fixture.

## Limits

This proves selective omission of a typed socket endpoint at SCM_RIGHTS receive
while ordinary descriptor IPC remains usable. It does not test an already-owned
endpoint after policy change, inheritance across fork or exec, pipe authority,
all source domains, dynamic relabel attacks, authenticated peer admission,
release payload integrity, process lifetime binding, Electron children, or
compositor capture/input. The intentionally generous base grants and narrow
fixture policy are not suitable as a production security policy.

Results always report `releaseIdentityEstablished: false`,
`computerUseEnabled: false`, and `inheritedPipeOrElectronRoleProof: false`.

```sh
node --test scripts/linux-protected-ipc-probe/verify.test.mjs scripts/linux-protected-ipc-probe/cleanup.test.mjs
```
