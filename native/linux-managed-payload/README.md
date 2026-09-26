# Local managed payload staging

This Linux-only crate creates a private, root-managed generation. It does not
verify release attestations, activate or execute a payload, install SELinux
policy, enable Computer Use, or make files kernel-immutable. Host root, the
kernel, host namespaces and other root writers remain trusted.

Build with `cargo build --locked --release`. The current acceptance host uses
Fedora cargo/rust 1.98.1. Runtime requires SELinux enforcing, procfs, working
extended-attribute APIs, libselinux, `openat2` resolution flags and `renameat2`
no-replace; unsupported host behavior fails without a compatibility fallback.

```
aiden-managed-payload stage --store /var/lib/aiden-staging/store --source /absolute/extracted/payload --inventory /var/lib/aiden-staging/inventory.json --approval /var/lib/aiden-staging/approval.json
```

Create the store and approval area explicitly through trusted administration.
The store must have mode 0700. Its ancestors and approval/inventory ancestors
must be root:root, lack group/world write and have no extended/default ACL.
The inventory uses the Phase 16 schema and must be external to both payload and
store. Store and source must not overlap. The strict approval record is:

```json
{"schemaVersion":1,"kind":"local-staging-only","inventorySha256":"<SHA256 of exact inventory file bytes>","packageSha256":"<64 lowercase hex diagnostic operator value>"}
```

The package digest is diagnostic: this component establishes no cryptographic
relationship between that package and the inventory. This local-only approval
must never satisfy a future authenticated-release admission gate.

The destination is `STORE/INVENTORY_SHA256/payload`, with separate inventory,
approval and receipt files inside its root-only generation container. All
payload modes and contents match the approved inventory. Group/world write,
setuid/setgid/sticky modes, unreadable files and unsearchable directories are
outside the initial profile. No special chrome-sandbox permission exception is
made. ACLs, capabilities and other unsupported xattrs are rejected, not copied.
New objects receive the store's exact SELinux context through a scoped
libselinux fscreate setting and readback, preventing filename transitions such
as Fedora's `shared` directory rule. The guard requires an initially default
creation context, restores and reads back the default before publication and on
error, and aborts if restoration fails. No existing inode is relabeled. This
staging label is not executable identity. A complete destination traversal and
rehash precede an exclusive atomic rename and parent-directory fsync. No active
pointer exists.

Caller-controlled traversal uses descriptor-relative `openat2` with BENEATH,
NO_SYMLINKS, NO_MAGICLINKS and NO_XDEV below established roots. Source objects
are first pinned/classified with O_PATH, preventing device or FIFO I/O. Reading
uses an intentional exception: reopening our retained numeric descriptor through
verified `/proc/self/fd`, comparing metadata before/after. Caller paths are never
used in that exception. Copying into fresh inodes means retained writable source
descriptors do not become handles to the staged destination.

Failures before rename remove only the newly created private temporary tree.
Cleanup errors are reported. If rename succeeds but parent fsync fails, the CLI
reports uncertain durability and leaves the private generation in place; it does
not claim success or delete a published generation.

Run ordinary unprivileged tests with `cargo test --locked`. The registered npm
wrapper runs these on Linux, fails if cargo is unavailable, and skips on macOS.
The ignored root integration is explicit, runs only in an authorized disposable
Fedora host, and never invokes sudo itself:

```
# Build as the normal development user, then invoke the built library test
# executable as trusted root with --ignored --nocapture.
cargo test --locked --lib --no-run
```

It uses exclusive `/var/lib/aiden-managed-payload-tests-PID-N` directories and
cleans them after each scenario. The build needs libselinux development files
(`libselinux-devel` on Fedora, `libselinux1-dev` on Ubuntu). The integration host
also needs `setfacl` from Fedora's `acl` package. Tests cover fresh
inode/retained writer separation, pinned path swaps, actual device classification
without IN_OPEN, malformed inventory/approval, ACL/capability/link/FIFO
rejection, ownership/mode and overlap checks, exclusive publication and injected
prepublication failures with cleanup.
