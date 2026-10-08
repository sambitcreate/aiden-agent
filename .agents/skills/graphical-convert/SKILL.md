---
name: graphical-convert
description: Apply a supplied Graphical theme to an existing app or interface. Inventory current styling, map tokens and components, and plan or implement a scoped conversion while preserving application behavior. Use for adopting Graphical or migrating legacy UI to its theme.
---

# Convert an interface to Graphical

Use this for theme adoption, including partially converted apps. Follow a planning-only request without editing source; a request to implement conversion already authorizes the requested implementation. Do not add a mandatory approval round for routine mappings.

## Establish scope and target

Identify the requested app, feature, or screen and the supplied target theme. Read the project root `GUI.md`, `gui/theme-contract.md`, and `gui/foundations.md`. Locate these from the app root; if the guidance has not been added yet, follow the project setup steps in `GUI.md`. Do not invent a theme, registry URL, or package source when the required artifact is missing.

Record the framework, styling system, shared components, theme/mode wiring, and existing customizations. Preserve dependencies and application behavior. Define the referenced values as named tokens in the app’s existing theme system. The download contains guidance, not application code or an installer; a style migration does not require rebuilding the host app.

## Map before editing

Read [mapping examples](references/mapping-examples.md). Inventory theme-controlled styles in the requested scope, including existing tokens/aliases, utility configuration, shared primitives, local overrides, states, and portals. Inspect representative consumers to understand each shared style’s meaning and reach.

Build a mapping from each current role to a verified target token, component, or adapter. Match semantic purpose, hierarchy, density, and state rather than the nearest numeric value. Distinguish confirmed mappings, intentional exceptions, and unresolved gaps. Never map a required distinction to an indistinguishable treatment just to complete the table.

For a planning request, deliver the mappings, shared dependencies, implementation order, and affected checks, then stop. For implementation, use that map as the work plan and continue; ask only about missing decisions that materially affect the result.

## Convert in dependency order

1. Connect the target theme and styles at the existing application boundary. Keep mode ownership in the app. Avoid nested static providers and competing global resets.
2. Adapt shared style/token boundaries and components before leaf overrides. Inspect their consumers; for a limited-scope conversion, do not unintentionally retheme unrelated screens through a global change. Use the existing scoping mechanism or explain the broader dependency.
3. Convert the requested screens and relevant states, including typography bundles, surfaces, icons, responsive spacing, and portal scopes. Delete superseded styles only after confirming their consumers are covered.
4. Preserve routing, data, handlers, refs, form values, keyboard interactions, accessible names, and state distinctions. Replacing the app’s primitive library is not an incidental conversion step. Read `gui/base-ui.md` for Base UI primitives or `gui/custom-components.md` for adaptations.

Keep the target theme’s existing vocabulary. Report unmapped roles or incompatible APIs rather than inventing tokens, silently changing dependencies, or flattening meaningful differences. Existing artwork, domain color encodings, and third-party widgets need contextual decisions, not blind replacement.

## Verify and report

Follow `gui/verification.md` and the host’s review policy. Reinspect the converted scope for remaining overrides and broken theme/mode propagation. Check affected behavior when component wiring changed. Do not describe source checks as visual review.

Report the converted scope, important mappings, preserved exceptions, remaining gaps, and verification. Group unfinished work by its owning component or style source so a later pass can continue without repeating discovery.
