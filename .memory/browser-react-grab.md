# Browser Element Grab (React Grab)

Implemented 2026-11-22 for the embedded desktop Workspace Browser (`Environment → Browser`).

## Architecture & Decisions

- **Zero new preload IPC channels:** Reuses `browser:command` (`{ action: "grab", tabId, enabled, accent? }`) and `browser:event` (`grab`, `grab-ended`, `shortcut: "grab"`).
- **Zero Remote protocol revision required:** Stores structured metadata on `ChatMessage.grabbedElements?: GrabbedElementContextV1[]` (`renderer/shared/browser-element-grab.ts`) paired with an optional standard `kind: "image"` attachment whose id is `grab-thumb_<elementId>`.
  - Desktop `MessageAttachments` filters out `grab-thumb_*` via `withoutGrabbedElementThumbnails()`, while `MessageBubble` renders read-only `<GrabbedElementChips>` pairing each element with its thumbnail by `thumbnailAttachmentId`.
  - Paired iOS/Android clients continue to see the user message plus the cropped PNG image attachment without breaking `AttachmentKind`.
- **In-page grab runtime & loopback-only source maps:**
  - Injected into the guest `WebContentsView` main world via `executeJavaScript` (works alongside open DevTools, CSP-immune via Closed Shadow DOM + inline `el.style`, zero page-context network calls).
  - Supports React 16–19 (including React 19 `_debugStack` + RSC `_debugOwner`), Vue, Svelte, Astro, Preact, Solid, Angular, and plain HTML/CSS via getter-safe `Object.getOwnPropertyDescriptor` reads.
  - `ArrowUp`/`ArrowDown` component-tree stepping, `Shift+Click` multi-grab (`keepActive: true`), `F` animation freeze, 2-rAF overlay hide before screenshot capture, and unstoppable Escape via main's `before-input-event`.
  - Main-process Base64-VLQ source-map symbolication (`main/services/browser/grab-source-map.ts`) fetches only from the authoritative page's exact loopback origin (scheme, host, port), or `file://` only for a `file://` page with a workspace root and realpath containment, with `redirect: "error"`, 1500ms timeout, and LRU caching (2026-11-24, Pullfrog finding).
  - While grabbing, every iframe/frame/embed gets inline `pointer-events: none !important` (`FrameShield` in `grab-runtime/index.ts`) so frame input lands on the top document and is suppressed; hit tests lift the shield synchronously to descend into same-origin frames. Props drop `value`/`defaultValue` always and all text on credential fields (`sensitiveTarget`).
  - Grab holds a background-throttling lease for the session: a detached DevTools window covering the app on macOS otherwise pauses the page's animation frames, and the 2-rAF capture wait never resolves (also bounded by a 100 ms timer). Region screenshots read the viewport in the isolated CDP world, not the page's main world.
  - Main-process thumbnail capture (`grab-thumbnail.ts`) clamps to viewport, handles Retina/zoom scaling, masks credential fields (`credential-fields.ts` + `credential-mask.ts`), and resizes to <= 640px / <= 512 KiB.
  - In-page highlight color follows active Aiden `--fill-accent` / `--fill-accent-foreground` with automatic `#006AD6` / `#FFFFFF` fallback when accent saturation < 0.12 (`resolveGrabAccent`).
- **Composer & Transcript UI (`renderer/components/grabbed-element-chip.tsx`, `composer.tsx`, `chat-pane.tsx`):**
  - Each chip renders two sibling `<button>`s (trigger + inline trailing `size-8` squircle `×`) with zero `nested-interactive` axe violations, matching Aiden's `@mention` and attachment chips.
  - Inspection popover uses Aiden's `Popover` / `PopoverContent` (`data-slot="popover-content"` for `BROWSER_NATIVE_OCCLUDER_SELECTOR`), `side="top" align="start" sideOffset={8}`, borderless `rounded-popover bg-popover shadow-popover border-0`, `250ms` hover open / `140ms` grace close, click-to-pin, and auto-pin when expanding `"Show N more details"` or copying context.
  - Expandable details use `useCollapsibleBody` with `--motion-duration` / `--motion-easing` and `:root[data-reduce-motion="true"]` parity.
  - Delivered via `browserElementGrabDelivery` (`ComposerDeliveryRegistry`) fenced on `firstSendPendingRef || sendPendingRef || !available()`, deduplicated in place by `grabbedElementDedupKey`, capped at 10 elements / 256 KiB.
  - Stored per-chat in memory in `composer-draft-store.ts` (never `localStorage`), preserved across failed sends, queued messages (`chat-message-queue.ts` + `queued-messages.tsx`), worktree sends (`draft-worktree-send-view.tsx`), and Edit in fork.
  - Empty-text send is allowed; Steer is disabled and `/btw` is guarded while grabbed elements are attached; Backspace at caret 0 removes the last chip (after mentions).
  - Never blocks text-only models (`visionSupported === false`): shows a non-blocking `"Text context only for this model"` note in the composer and popover while sending the full deterministic `<attached-browser-elements>` block (omitting `grab-thumb_*` image blocks and fallback lines).
- **Exclusions & Safety:** Refused in Bot browsers (`BOUNDARY_REFUSED_ACTIONS`, hidden on `variant="bot"`). Main supplies authoritative `pageUrl`/`pageTitle`, redacts sensitive values/attributes, and treats all grabbed fields as untrusted reference material.
- **Analytics & Onboarding:** Content-free events `browser_element_grabbed` and `browser_grab_sent` documented in `docs/analytics.md`; existing `browser` onboarding tile updated in `onboarding-feature-gallery.tsx` and `onboarding-art/create-art.tsx` (code-drawn, zero raster images).
