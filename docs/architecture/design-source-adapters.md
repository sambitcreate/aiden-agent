# Design Source Adapters

Status: Implemented for the supported Vite/React and bounded Next.js fixtures. Main-generated
source graphs, header-bound preview capability transport, HMR containment, and packaged acceptance
are complete; unsupported source shapes fail closed.

## Boundary

Design source adapters translate an observed preview element into a reviewable workspace source
range. They do not grant file, command, network, process, Git, or mutation authority. A selection is
usable only when main can prove all three identities at the same time:

1. the exact runtime instance and selector;
2. the exact component identity and workspace-relative source range;
3. the current source hash from the authorized workspace.

The renderer and preview are untrusted reporters. Main creates and validates the manifest, obtains
current file hashes through existing workspace authority, and applies changes only through Designer
Action review.

## Source manifest and runtime-instance graph

`design-source-graph-core.ts` defines the bounded `DesignSourceManifestV1` contract. A manifest is
hash-bound and contains only:

- stable manifest, workspace, component, and runtime-instance IDs;
- bounded runtime selectors;
- workspace-relative file names, SHA-256 source versions, and exact source ranges;
- custom-component definition identity and runtime parent relationships.

It deliberately excludes absolute paths, source bytes, commands, preview URLs, credentials,
capabilities, and write authority. Every object rejects unknown fields, paths reject traversal and
backslashes, arrays and serialized bytes are capped, and the manifest hash covers the canonical
body.

`resolveDesignSourceSelection` fails closed when:

- a runtime ID and selector do not identify the same single graph node;
- the reported component ID differs from the manifest;
- the request refers to another manifest revision;
- main does not supply a current file hash or that hash changed;
- multiple runtime nodes share one JSX render site;
- a component-definition operation would affect repeated instances.

This is intentionally stricter than DOM-only selection. A repeated list item may have a unique DOM
selector while every item still originates from one JSX range. The core calls that ambiguous rather
than pretending a source edit affects only one rendered item.

## Vite HTTP and HMR transport policy

`source-preview-transport-core.ts` models transport authority as an ephemeral, immutable proof. Main
may issue a proof only for an exact `http://127.0.0.1:<fixed-port>` origin that it just observed as
the sole resolved loopback address. `localhost`, hostnames, IPv6 aliases, default ports, URL
credentials, multiple addresses, and non-HTTP origins do not qualify.

The proof contains explicit HTTP and WebSocket path prefixes, HTTP query-key allowlists, exact
hashed values for internal WebSocket transport parameters, and WebSocket subprotocols. A
structurally identical renderer object is not a proof; only a proof issued inside the main process is
accepted.

Integration must use manual HTTP redirects and call the policy for the original request and every
redirect destination. It must resolve or otherwise effect-time prove the destination immediately
before each connection. Automatic redirect following is incompatible with this contract.

HMR has two checks:

1. authorize the proposed `ws://127.0.0.1:<same-port>` target, path, query, protocol, and fresh
   address observation;
2. authorize the actual upgrade headers, exact `Host`, corresponding HTTP `Origin`, WebSocket
   version/key, and protocol list.

Both HTTP and WebSocket paths reject cookies, authorization, credentials modes, unknown headers,
remote origins, hostname rebinding, port drift, encoded path separators, fragments, and unproven
paths or query keys. `source-preview-websocket-proxy.ts` applies that proof to the real upgrade: it
opens only a numeric IPv4 loopback socket, refuses upgrade redirects, validates the upstream
challenge response, reconstructs a minimal credential-free `101`, and owns every upgraded socket
through teardown. Vite begins with HMR unproven; after the proven `/@vite/client` response exposes
its bounded runtime token, main issues an exact token-hash and `vite-hmr`/`vite-ping` proof.

## Next.js capability fixtures

`source-preview-transport-next-adapter.ts` is a pure classifier over normalized, authorized-read
evidence. It does not inspect the filesystem, execute `package.json`, launch a process, or accept
source bytes. Separate fixture axes record:

- App Router, Pages Router, hybrid, or absent router evidence;
- webpack, Turbopack, ambiguous, or unknown bundler evidence;
- client, server, mixed, or unknown component-boundary evidence;
- current, missing, stale, or ambiguous source-graph evidence.

The four explicit client/current combinations—App or Pages crossed with webpack or
Turbopack—classify as supported source-selection candidates. `supported` still means HMR requires a
live loopback transport proof and edits require Designer Action review. Server, mixed, unknown, or
non-current source graphs are preview-only. Hybrid/absent routers, ambiguous/unknown bundlers,
non-`next dev` commands, and targets whose host or port is not controlled are unsupported.

`source-preview-next-runtime-adapter.ts` supplies the authorized-read production side of that
boundary. It reads a bounded real `package.json`, detects `next dev`, chooses the documented Next 16
Turbopack default or explicit webpack/Turbopack flags, walks non-symlink App and Pages route files,
normalizes static/dynamic route fixtures, and distinguishes App Router server pages from explicit
`use client` pages. It launches through the package manager without a shell override and appends an
exact `--hostname 127.0.0.1 --port <owned-port>` pair. App and Pages projects use separate route
classifications even inside a hybrid repository; a source edit remains preview-only until a trusted
current source graph is attached.

## Required integration sequence

1. Build the source manifest from trusted compiler/plugin output and authorized workspace reads.
2. Pin it to the current preview session and source hashes; never accept a renderer-authored
   manifest as authority.
3. Replace automatic preview redirects with manual hop handling through the transport policy.
4. Keep HMR behind both target and actual-upgrade proof, and preserve the controller teardown that
   closes upgraded sockets plus escalates a stopped owned child process when graceful termination
   expires.
5. Feed filesystem evidence through the bounded Next.js runtime detector into the pure classifier.
   Do not execute project configuration to discover it.
6. Route resolved ranges into the existing hash-bound Designer Action transaction. Revalidate the
   source hash again at review and apply time.
7. Complete packaged, navigation, orphan-process, App/Pages, webpack/Turbopack, server/client, and
   repeated-instance acceptance before advertising adapter support.

Until trusted source manifests and packaged/operator acceptance are complete, the adapters provide
live preview and HMR but must not advertise source selection as authoritative.
