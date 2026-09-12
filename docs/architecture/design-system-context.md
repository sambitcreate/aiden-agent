# Local design-system context boundary

Design-system context is an explicit, read-only attachment to a Design Project. It is context for a selected model turn, never repository, command, network, Git, or write authority.

## Data boundary

The Phase 4 core accepts already-authorized read results. It does not scan a workspace, resolve package entry points, import modules, execute package scripts, evaluate JavaScript, load CSS through a browser, or follow symlinks. The caller must resolve the user-confirmed package/route selection and supply regular-file metadata plus pre-extracted semantic candidates.

Two records have deliberately different visibility:

- `DesignSystemSnapshotV1` is path-free and safe to project to a renderer or include in the exact model-context preview. It contains normalized semantic tokens, reviewed component metadata, icon metadata, and source hashes.
- `AttachedDesignSystemRecordV1` is main-only. It binds opaque source IDs and hashes to bounded workspace-relative paths so a later authorized refresh can prove whether the snapshot is current.

Neither record stores absolute paths, source text, executable code, capabilities, commands, workspace mutation handles, credentials, or network locations. A snapshot hash covers normalized semantic content and its sorted source hashes. Refresh time and revision are outside that content identity.

## Supported semantic surface

Version 1 supports bounded static values only:

- colors;
- spacing;
- typography families, size, line height, weight, and letter spacing;
- radii;
- shadows;
- an explicitly reviewed component catalog with variants and states;
- icon names, labels, styles, and tags.

Semantic names are preserved rather than replaced with generated aliases. Arrays are sorted for deterministic serialization, duplicate names are rejected case-insensitively, and unknown keys fail closed. Dynamic expressions such as `var()`, `calc()`, `env()`, `url()`, interpolation, and executable objects are unsupported in V1. Unsupported source forms, directories, and symlinks are also rejected rather than guessed.

## Freshness and detach

The snapshot alone cannot claim freshness. Before exposing a snapshot as current, main compares every retained source ID, workspace-relative path, and SHA-256 hash with a new already-authorized read result. A missing, moved, added, or changed source produces `missing` or `changed`, and the current-snapshot API returns no snapshot until an explicit refresh succeeds.

Detach increments the attachment revision and removes both the normalized snapshot and all workspace-relative provenance. It retains only the prior snapshot hash and source hashes for bounded audit correlation. A detached record cannot be refreshed implicitly; attaching again must be a new explicit user action.

## Integration obligations

The main/IPC wiring must:

1. ask the user to choose and confirm an already-authorized workspace/package/route;
2. perform bounded, no-follow regular-file reads and revalidate filesystem identity at publication;
3. show the exact path-free snapshot before a user accepts a model turn;
4. refuse to label or send a stale snapshot as current;
5. persist main-only provenance under the owner-only atomic store contract;
6. ensure exports never include proprietary source files or main-only provenance.

## Production adapter

The production adapter is split into three main-only layers:

- `design-system-workspace-extractor.ts` pins the canonical workspace device/inode, accepts only an explicit user-reviewed list of workspace-relative regular files, rejects symlinks in every path segment, reads through `O_NOFOLLOW` descriptors, bounds each file to 256 KiB and the selection to 512 KiB, and revalidates path, file, and workspace identity after the read.
- `design-system-snapshot-store.ts` persists at most 64 core attachment records in an 8 MiB owner-only atomic `DataStore`. Mutations are revision/CAS guarded and corrupt, schema-unsafe, or externally replaced stores fail closed without replacing the original bytes.
- `design-system-attachment-service.ts` composes explicit attach, refresh, freshness projection, and detach. Every filesystem operation requires the caller to resupply the currently authorized and reviewed workspace selection; an attachment ID is not a reusable filesystem capability.

Version 1 extraction deliberately supports two static JSON document types rather than attempting to interpret arbitrary package code:

- `tokens-v1` reads an exact `{ version: 1, kind: "tokens", tokens }` document with colors, spacing, typography, radii, and shadows.
- `catalog-v1` reads an exact `{ version: 1, kind: "catalog", components, icons }` document. Every component entry must include `reviewed: true`.

Unknown keys, dynamic token values, invalid UTF-8/JSON, JavaScript/TypeScript modules, CSS evaluation, package resolution, directories, and symlinks fail closed. The renderer projection contains attachment state plus a path-free snapshot only when current hashes are proven; it never contains provenance, absolute paths, or raw document text.

The application wiring initializes the store, exposes narrow IPC handlers, obtains workspace
identity from an authorized workspace and explicit package/route confirmation, binds the accepted
revision to the Design Project, shows the path-free model-context preview, and re-runs freshness
proof for accepted model turns. Prompt integration and output validation consume only that
proven-current projection. Exports exclude the main-only record and proprietary source documents.
