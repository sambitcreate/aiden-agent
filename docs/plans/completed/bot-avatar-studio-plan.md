# Bot Avatar Studio

Status: Complete

Started August 18, 2026. This is a follow-on to the completed Bots Mode plan: it changes only the bot identity artwork and its editor, while preserving the existing Pi conversation, Telegram binding, workspace, tool, and permission contracts.

## Outcome

Replace the fixed six-avatar picker with a live layered vector studio. People can choose a bright pastel body, abstract shape, eyes-only expression, and non-facial detail manually, shuffle a recipe, or ask any configured Aiden Pi provider/model to suggest a bounded recipe from a description.

## Invariants

- Existing `spark`, `orbit`, `leaf`, `prism`, `wave`, and `ember` records remain valid and resolve deterministically into the new versioned appearance contract.
- Faces contain eyes only. Eye ink remains dark in both light and dark appearance modes.
- The renderer can submit only a bounded prompt, provider/model identifiers, and a valid current appearance. It cannot supply a generation system prompt or arbitrary SVG/HTML/color values.
- Pi suggestions are tool-free, main-owned, schema-validated, timeout-bounded, cache-free, and usage-accounted without retaining prompts or generated content.
- Bot conversations, personas, Telegram bindings, workspaces, provider inheritance, and permissions are unchanged.

## Delivery phases

1. Add a backward-compatible versioned appearance contract and layered SVG renderer.
2. Add strict main-owned Pi suggestion generation and IPC.
3. Replace the fixed picker with an accessible live-preview modal studio.
4. Refresh Bots onboarding copy/art, migration tests, and runtime contracts.
5. Run focused/full validation, React Doctor, and interactive development acceptance.

## Reference adaptation

`/Users/sambitbiswas/Downloads/bot-face-gen` informed the layered recipe, live option previews, shuffle flow, and prompt-to-configuration interaction. Aiden does not import its Gemini key storage, browser-local persistence, human face parts, mouth/nose layers, export tools, or Notion styling. The implementation uses Aiden semantic tokens, main-owned storage, and the existing Pi provider registry.

## Completion

Completed August 18, 2026. The versioned renderer, manual and Pi-assisted studio, onboarding artwork, migration coverage, IPC validation, usage accounting, full test suite, build, and React Doctor review all passed before handoff.

Follow-up hardening projects recognized model fields onto the bounded recipe, discards unknown fields, normalizes common labels, and uses a deterministic eyes-only local matcher when a provider returns malformed output. Reasoning-capable models also receive a larger bounded completion allowance.

The final three-agent adversarial pass added a crash-reconciling rollback companion store with orphan pruning, owner-scoped cancellation and single-flight admission, explicit no-reroute model selection, shared chat-model eligibility for catalog/provider-declared embeddings, rerankers, and non-text media models plus bounded family heuristics, aggregate text/thinking/tool output bounds with full terminal-envelope validation, abort-raced runtime/catalog/provider/accounting awaits, runtime-keyed usage identity, closed provider errors, save-time editing fences, and keyboard-complete tab semantics.
