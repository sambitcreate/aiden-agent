# Renderer custom-protocol compatibility

Status: Deferred compatibility follow-up to W12, October 27, 2026. No custom-protocol or fuse behavior changes are part of the distribution-authenticity/CSP candidate.

The renderer currently loads packaged `file://` pages through `main/windows/window-paths.ts`. `GrantFileProtocolExtraPrivileges` stays enabled in `scripts/configure-electron-fuses.mjs` until a registered application protocol proves equivalent required behavior. Removing development script/style origins from production HTML is independent and does not establish protocol compatibility.

Implement a fixed application scheme with path containment, explicit MIME handling, CSP and immutable asset routing. Review navigation, permission and sender admission wherever production currently recognizes file URLs. Preserve the development server workflow. Do not make arbitrary local files reachable through the new scheme.

Acceptance requires signed packaged macOS and Linux checks for every renderer entrypoint, preload and IPC sender checks, relative asset/CSS/font/image resolution, terminal WASM, audio worklets, Web Workers/blob paths, local image/media URLs, `aiden-asset:` and `aiden-genui:` interactions, drag/drop and external navigation, Device Hub streams, custom providers and the phone visual viewer. Add behavioral route/traversal tests and monitor CSP violations in the real package. Only then disable `GrantFileProtocolExtraPrivileges` and verify the final binary's fuse wire. Roll back the scheme/fuse change together if compatibility fails.
