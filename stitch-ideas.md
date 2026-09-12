# Stitch ideas for Aiden Design

Date: 2026-09-03

Status: Product and interaction research. This is not an implementation plan and does not change the existing Design contracts.

## Executive recommendation

Keep Aiden Design local-first. Do not pivot it into a hosted clone of Stitch.

The useful lesson from Stitch is its interaction model:

```text
prompt → screens → select a screen → explore or refine → preview → inspect/export → build
```

Aiden already has most of the harder foundation: durable local projects, immutable generated revisions, a spatial canvas, source inspection, deterministic export, comments, bounded visual edits, design-system context, and a recoverable handoff into a real workspace. The next improvement should make those capabilities feel like one coherent design loop instead of a collection of canvas controls.

The highest-value changes are:

1. Start with the brief, not a naming form. Create the project immediately and auto-name it from the first successful design turn.
2. Make **Screen** the primary user-facing object, while retaining artboard lineage as the internal revision identity.
3. Split generation into explicit **Explore**, **Refine**, and **Build prototype** intents.
4. Add first-class variation sets with a creative-range control and a clear “choose as direction” action.
5. Keep canvas selection, conversation artifact cards, composer context, inspector, and keyboard navigation synchronized.
6. Make a project-local design language available before connecting a code workspace.
7. Turn the inspector into a dependable screen workbench for Preview, Code, History, and later Inspect—not a panel users must discover through icon state.
8. Preserve **Continue in workspace** as the explicit boundary between design intent and repository-changing engineering work.

## Research scope and evidence

This review used:

- the authenticated Stitch project [Vibrant Cookbook Home](https://stitch.withgoogle.com/projects/630813151835158995?pli=1), inspected in Chrome on 2026-09-03;
- the official [Stitch documentation](https://stitch.withgoogle.com/docs), especially the overview, prompting, device types, design modes, variations, controls, MCP, and `DESIGN.md` pages;
- the running Aiden Agent Dev app from this branch, including the local `Untitled Design` project with three Love Day artboards;
- Aiden's current renderer, project contract, storage, design-system, direct-edit, source-adapter, export, and handoff documentation.

“Observed” below means it was visible in the inspected Stitch project or running Aiden build. “Documented” means it appears in the linked official Stitch documentation. “Proposed” is an Aiden recommendation, not a claim about either shipped product.

## What Stitch is doing

### 1. The project is a spatial collection of screens and references

Observed in the inspected Stitch project:

- one large dotted canvas holds many named screen frames and reference images;
- screens remain visible together, making comparison spatial rather than tab-based;
- a selected screen shows its dimensions and receives the current prompt context;
- the project conversation floats over the canvas rather than becoming the project hierarchy;
- the composer is a floating command surface with the selected screen shown as a removable chip;
- Select, Pan, Zoom, fit-to-view, undo, redo, and zoom percentage remain available without leaving the canvas.

This is an important distinction: conversation explains the work, but screens are the work.

### 2. Generate, Modify, Preview, and Export are separate verbs

The inspected top toolbar presents four legible modes:

- **Generate** for creating or deriving design material;
- **Modify** for targeted changes;
- **Preview** for experiencing a screen at a device size;
- **More** for details, source, Figma, export, download, reload, and delete.

The observed Generate menu included:

- Instant Prototype;
- Variations;
- Regenerate;
- Predictive Heatmap;
- Desktop Web Version;
- Missing States;
- Animate;
- App Store Assets;
- Web Assets;
- Marketing Kit;
- Accessibility Audit.

The breadth is less important than the taxonomy. Users choose what kind of design operation they want before they prompt. The model is not expected to infer every operation from prose.

### 3. Exploration and precision are different workflows

The [variations guide](https://stitch.withgoogle.com/docs/learn/variants/) explicitly separates:

- normal chat for one or two precise changes to a screen; and
- variations for broad exploration, getting unstuck, or changing direction.

Stitch supports one to five options and exposes a creative range:

- **Refined** preserves structure and explores typography, spacing, and color;
- **Creative** permits layout, imagery, and theme changes.

The recommended loop is to select a winner, then generate refined variations from that winner. This creates a visible branch-and-converge workflow instead of an undifferentiated list of generations.

### 4. Prompting is scaffolded around design intent

The [overview](https://stitch.withgoogle.com/docs/learn/overview/) teaches an initial brief as:

- Idea;
- Theme;
- Content;
- optional reference image.

The [prompting guide](https://stitch.withgoogle.com/docs/learn/prompting/) then encourages incremental screen-level edits that identify:

- the target screen;
- the target component;
- the requested visual change;
- relevant UI or UX vocabulary.

This lowers the burden on a user who knows what they want but does not know how to write a perfect design prompt.

### 5. Device type is treated as design context, not a viewport toggle

The [device-types guide](https://stitch.withgoogle.com/docs/learn/device-types/) distinguishes App and Web as primary design surfaces. It says platform translation should change navigation, hierarchy, and density—not merely resize the same layout.

The inspected Preview menu offered:

- new-tab preview;
- QR code;
- Mobile at 390 × 884;
- Tablet at 768 × 1024;
- Desktop at 1280 × 1024;
- full height.

Stitch's own documentation acknowledges a weakness here: changing device type inside an existing project can need manual frame adjustment. Aiden should borrow the explicit intent while avoiding a frame-size-only implementation.

### 6. Source is a direct property of a selected screen

Observed **View Code** opened a modal containing the selected screen's generated document. In this project it was a standalone HTML document using Tailwind's CDN configuration and external Google Fonts. The visible action was **Copy code**.

The [overview](https://stitch.withgoogle.com/docs/learn/overview/) describes HTML plus a reference image as an intermediate representation that an LLM can translate into React, Angular, Vue, Jetpack Compose, Flutter, or SwiftUI.

Stitch's model is therefore not “the design is a production repository.” It is closer to “a screen has visual output and an HTML handoff representation.” Aiden's explicit prototype-versus-workspace boundary is compatible with this and safer.

### 7. Export is a handoff matrix

The inspected Export dialog offered:

- AI Studio;
- Figma;
- MCP;
- Netlify;
- Lovable;
- Bolt;
- `.zip`;
- Code to Clipboard;
- Project Brief.

The dialog includes a short handoff description, with “Make this real” as its default for AI Studio. The valuable idea is not supporting every destination. It is treating export as an intentional continuation with format-specific expectations.

### 8. `DESIGN.md` makes design language portable

The official [`DESIGN.md` overview](https://stitch.withgoogle.com/docs/design-md/overview/) defines a human- and agent-readable design-system document with:

- machine-readable YAML tokens;
- human-readable Markdown rationale;
- extensible colors, typography, spacing, radii, and component guidance.

It is described as a living artifact rather than a static configuration file. The [codebase import guide](https://stitch.withgoogle.com/docs/design-md/get-instructions/) describes three inputs:

- generate a design language from a prompt;
- derive it from a URL or brand image;
- extract it from an existing codebase.

This is one of the best ideas for Aiden, but Aiden should make it local and provenance-aware.

### 9. Stitch has an agent-facing resource model

The [Stitch MCP documentation](https://stitch.withgoogle.com/docs/mcp/setup/) exposes separate operations for:

- projects;
- screens;
- screen generation and edits;
- variation generation;
- design systems.

Notably, `generate_variants` accepts the project, selected screen IDs, a prompt, and options such as count, creative range, and aspects. That is a cleaner agent contract than making every design task a generic chat append.

Stitch's MCP is remote and cloud-authenticated. Aiden does not need to copy that deployment model to gain the benefit of an explicit resource vocabulary.

## What Aiden Design has now

### Product surface observed in the running app

The current build already provides:

- an Agent/Design mode switch;
- a local Design project library with search and Prototype/Connected filtering;
- local project creation;
- a project header that labels origin and local persistence;
- a collapsible project conversation;
- a composer with attachments, thinking level, model selection, voice input, and selected-artboard context;
- an infinite dotted canvas;
- Select, Visual edits, Preview, New design, Add reference image, and Hand tools;
- desktop, tablet, and phone targets;
- multiple generated artboards shown together;
- a selection inspector with Preview, Code, and History;
- per-revision model provenance;
- source copy, standalone HTML save, and bundle export;
- comments;
- a later Connect app flow;
- a guarded Continue in workspace flow.

### Durable project contract

Aiden's current public Design identity is `DesignProjectId`, not the backing chat ID. The backing chat owns conversation history, while the project snapshot owns bounded layout and opaque references:

- title and timestamps;
- connection state;
- canvas viewport and React Flow viewport;
- node positions;
- stable artboard lineage IDs;
- immutable artifact media-ID history and the active revision;
- reference-asset IDs;
- optional design-system binding;
- an optional preview script selection.

The project snapshot deliberately does not contain generated HTML, prompts, credentials, absolute paths, preview capabilities, or workspace source. Those live in purpose-built stores and authority boundaries.

This is good architecture. It should be extended, not replaced.

### Prototype and connected-app origins

Aiden already has the right conceptual split:

| Origin        | Canonical content                          | Change model                                            |
| ------------- | ------------------------------------------ | ------------------------------------------------------- |
| Prototype     | Aiden-owned immutable HTML/CSS/JS revision | Generate a new immutable revision                       |
| Connected app | Authorized workspace source                | Propose an exact, hash-bound Designer Action for review |

Connecting an app records a relationship but does not silently grant source-write authority. Continue in workspace passes a bounded, untrusted handoff packet into normal engineering permissions.

This is a stronger product promise than blurring prototype generation with repository mutation.

### Where Aiden is already stronger than Stitch

- **Local ownership:** project state and generated artifacts are stored by Aiden on the Mac rather than requiring a hosted design account.
- **Revision correctness:** immutable media IDs and lineages are stronger than title-based history.
- **Recovery:** publication, duplication, deletion, export, and handoff have explicit crash and uncertainty behavior.
- **Source honesty:** Aiden labels canonical generated source as read-only and distinguishes it from connected workspace source.
- **Engineering boundary:** Continue in workspace creates a reviewable implementation task without granting the Design project ambient Git or filesystem authority.
- **Safe direct edits:** prototype edits become immutable revisions; connected edits go through exact source proof and review.
- **Deterministic export:** the current bundle contract is designed to run offline and avoid credentials, absolute paths, and hidden internal state.

## Friction observed in the current Aiden build

These observations are useful because they show where strong architecture is not yet legible in the UI.

### 1. The project remained `Untitled Design`

The first prompt clearly described Love Day and the generated screens were named after it, but the project remained `Untitled Design` in both the library and header. Users should not need a separate naming chore before they have created anything, and the project should not remain generic after its concept is clear.

### 2. Conversation and canvas selection can disagree

Clicking a conversation artifact card made one generated screen render, but the canvas actions and inspector remained disabled until the artboard itself was clicked. The conversation card called the action **Open workspace**, even though the user was already in a local Design project and no engineering workspace had been created.

There should be one selection state. Selecting a screen from conversation, canvas, history, a navigator, or search should update every surface.

### 3. The initial canvas looked empty despite three durable artboards

The accessibility tree knew about three artboards, but the canvas appeared blank until an artifact card was chosen. Lazy mounting may be appropriate for performance, but the visual fallback must still show screen thumbnails or loading placeholders. Durable work should never look missing.

### 4. Code was present semantically but the rail disappeared visually

After selecting the Code tab, the accessibility tree exposed the find field, Copy source, Save HTML, metadata, source lines, and read-only provenance, but the visible inspector rail disappeared in the captured app state. Switching to History made the rail visible again.

This should be treated as a functional presentation bug, not a polish issue: source visibility is one of the core promises of Design mode.

### 5. Too much of the workflow is encoded as unlabeled icons

At rest, the canvas has separate icon groups for canvas tools, connected-app actions, device targets, handoff, direct edits, inspector, design system, comments, and Fit. Tooltips help, but they do not create a workflow hierarchy.

Stitch's top-level verbs are easier to parse because they answer “what am I doing?” before presenting the detailed command.

### 6. The design system is gated behind Connect app

In the inspected prototype-only project, Attach a design system was disabled with guidance to connect a local app first. That makes sense for extracting a codebase's exact tokens, but it blocks a project-local design language created from a prompt or reference images.

Design language and workspace connection should be separable concepts.

### 7. Responsive controls currently read as alternate artboard filters

Desktop, tablet, and phone controls are available, but the product does not yet explain whether they resize the selected output, filter existing artboards, request a translated design, or define the next generation target. Stitch's documentation is explicit that device translation is a design operation, not a resize.

## Comparison matrix

| Capability        | Stitch                                    | Aiden now                                              | Direction                                                |
| ----------------- | ----------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------- |
| Project ownership | Hosted project URL                        | Local main-owned Design Project                        | Keep Aiden local-first                                   |
| Primary object    | Screen                                    | Artboard lineage surfaced as an artboard               | Say Screen in UI; keep lineage internally                |
| Conversation      | Floating overlay and composer             | Persistent conversation rail and composer              | Make collapsible and selection-synchronized              |
| Exploration       | Named Variations flow, 1–5 options, range | Prompt can create multiple independent artboards       | Add variant-set semantics and compare/choose             |
| Precise iteration | Modify selected screen                    | Chat prompt with selected-artboard chip                | Add Refine intent and target summary                     |
| Prototype         | Explicit generation action                | Preview toggle over generated HTML                     | Promote “Build prototype” and state checks               |
| Device context    | App/Web plus preview presets              | Desktop/tablet/phone targets                           | Add primary surface and translation action               |
| Theme             | Edit Theme workflow                       | Connected design-system attachment and direct literals | Add local project Design Language                        |
| Code              | Screen-level HTML modal and export        | Read-only canonical source, save, bundle, history      | Aiden is stronger; fix discoverability/reliability       |
| History           | Canvas undo/redo and generations          | Immutable revision lineage with comparison             | Make it visible beside screen selection                  |
| Export            | Broad destination matrix                  | HTML, deterministic bundle, workspace handoff          | Keep focused; add Project Brief and copy bundle manifest |
| Build handoff     | AI Studio/partners/MCP                    | Recoverable managed-worktree task                      | Keep as Aiden differentiator                             |
| Source editing    | Design output handed to build tools       | Exact reviewed Designer Actions for supported apps     | Keep safety model; improve status language               |
| Design-agent API  | Remote MCP resources                      | Internal chat and IPC services                         | Add internal resource-shaped commands first              |

## Proposed Aiden experience

### Project library

Keep the current Design sidebar, but simplify project creation:

1. **New Project** opens a blank local project immediately.
2. The work surface focuses the brief composer.
3. The first prompt may optionally use a compact scaffold: Idea, Audience, Surface, Style, Must include.
4. On the first successful design publication, Aiden proposes or automatically applies a concise project title derived from the brief.
5. The title remains directly editable and never defines history identity.

The sidebar row should show:

- project title;
- local status;
- number of screens;
- primary surface, when known;
- last meaningful activity;
- a compact recovery indicator only when action is required.

Replace **Prototype / Connected** filters with filters that match the user's work:

- All;
- Ideas;
- Prototypes;
- Connected.

“Prototype” should describe interactive maturity, not merely the presence of generated HTML.

### Workbench layout

Use three conceptual surfaces, with at most two open at once:

```text
Project navigation | Canvas | Context panel
```

- **Project navigation** is the existing global Design sidebar.
- **Canvas** remains the durable spatial workspace.
- **Context panel** switches between Conversation, Inspect, Code, and History.

The current always-visible conversation rail plus a separate inspector can leave too little room for the work itself. Conversation and inspector should be sibling modes in one context panel, not simultaneous full-height rails by default. On a wide display, users may pin two panels intentionally.

The canvas toolbar should have labeled top-level actions:

- **Explore**;
- **Refine**;
- **Prototype**;
- **Inspect**;
- **Export**.

Canvas navigation tools—Select, Hand, Zoom, Fit—can remain in a compact floating rail because they describe how the pointer behaves, not the product workflow.

### Unified screen selection

Introduce one `DesignSelection` projection owned by the workbench:

```ts
type DesignSelection = {
  projectId: string;
  screenLineageIds: string[];
  primaryLineageId?: string;
  activeRevisionId?: string;
  source: "canvas" | "conversation" | "navigator" | "history" | "search";
};
```

This renderer projection does not grant authority. Main still resolves canonical project and revision identities for every action.

Selection behavior:

- clicking a conversation artifact card selects and centers the matching screen;
- clicking a canvas screen updates the composer chip, inspector, and navigator;
- selecting a history revision previews that revision without silently changing the active revision;
- Escape clears element selection first, then screen selection, then closes the context panel;
- multi-select clearly limits commands to those valid across all selected screens;
- `⌘←` and `⌘→` move through screens in deterministic spatial reading order;
- `0` fits the project and `?` opens a context-aware shortcut reference.

Rename **Open workspace** on a generated artifact card to **Show on canvas**. Reserve “workspace” for connected repositories and Continue in workspace.

### Explore

Explore is for divergent work. It should offer:

- number of directions: 2–5;
- creative range: Refined, Balanced, Bold;
- aspects: layout, visual style, typography, content hierarchy, imagery;
- starting point: blank brief, selected screen, or selected variation;
- optional references;
- a concise preview of which screens will be created.

Generated results should be represented as a variant set:

```ts
interface DesignVariantSetV1 {
  id: string;
  projectId: string;
  sourceLineageId?: string;
  sourceRevisionId?: string;
  memberLineageIds: string[];
  creativeRange: "refined" | "balanced" | "bold";
  aspects: string[];
  createdAt: number;
  chosenLineageId?: string;
}
```

This can be a separate bounded store or a V2 project projection. It should reference immutable lineages rather than duplicate HTML.

Each set receives a visible bracket or group label on canvas with actions:

- Compare;
- Choose as direction;
- Refine this;
- Keep all;
- Archive rejected options.

Choosing a direction should not delete the alternatives. It marks intent and improves navigation while keeping history recoverable.

### Refine

Refine is for one selected screen or a bounded multi-screen selection. The composer should show a compact target sentence:

> Refining “Checkout” v3 · desktop · one screen

Offer optional prompt scaffolds rather than mandatory forms:

- Change this element;
- Change layout;
- Change visual style;
- Change copy;
- Apply project design language;
- Bring an idea from another variation.

A target review before send should list:

- selected screen and exact base revision;
- reference images included;
- design-language snapshot included;
- whether the operation creates a new screen or a new revision;
- whether any connected source is merely context or is proposed for review.

The backend's existing compare-and-swap publication should remain the authority.

### Prototype

Separate three states that currently risk being conflated:

1. **Static design:** visual screen with no interaction promise.
2. **Interactive prototype:** generated or verified interactions inside Aiden's sandbox.
3. **Connected preview:** an authorized local app runtime.

Prototype actions can include:

- make selected screens interactive;
- define links between screens;
- generate missing states such as loading, empty, error, success, and permission denied;
- open an isolated preview;
- choose phone, tablet, or desktop preview size;
- run keyboard, hover, reduced-motion, and basic accessibility checks.

Do not advertise working interactions merely because an HTML document contains links. Store a bounded prototype graph and verification results separately from screen source.

A future local QR preview is useful, but it should be opt-in, time-bounded, authenticated, and explicit about LAN exposure. It is not a prerequisite for the main design loop.

### Inspect

Make Inspect a visible context-panel mode with these tabs:

- **Preview** — the one live sandbox already mounted on canvas;
- **Code** — canonical source with find, copy, save, provenance, byte size, and content hash;
- **History** — immutable revisions, comparisons, active revision, and Designer Actions;
- **Details** — screen dimensions, primary surface, generation intent, references, and design-language snapshot;
- **Comments** — unresolved and resolved notes for the selected revision.

The current “do not mount a second executable preview” approach is correct. The Preview tab should show a clear mini-map/selection status and controls that act on the existing canvas preview.

Code requirements:

- the rail must remain visually mounted for long and min-content-heavy source;
- use a horizontal code scroller without allowing source width to affect the rail's position;
- show loading, unavailable, stale, and repaired states inside the panel;
- never render the placeholder text `[Previous Design HTML omitted…]` as source;
- make source identity and revision identity visible before Copy or Save;
- keep connected source reads freshness-bound and read-only until a reviewed action exists.

### Design Language

Create a project-local **Design Language** that is available to Prototype projects without connecting a workspace.

Possible creation paths:

- describe a vibe in text;
- derive from selected reference images;
- derive from one or more chosen screens;
- import a local `DESIGN.md` file;
- later, extract a reviewed snapshot from a connected workspace.

Use two layers, similar in spirit to Stitch but aligned with Aiden's existing contracts:

```text
machine layer: normalized, bounded semantic tokens and component states
human layer: rationale, principles, do/don't guidance, and provenance
```

Important Aiden differences:

- the machine layer remains exact-key parsed and bounded;
- source provenance remains main-owned and path-safe;
- dynamic expressions and executable configuration remain unsupported unless a separately contained extractor is approved;
- the project can have a local authored language without a workspace;
- connecting a workspace can compare or merge its extracted snapshot with the local language rather than replacing it silently;
- every generation records the exact design-language snapshot hash it used.

Suggested project UI:

- **Create language** for a project without one;
- **View language** with Colors, Type, Space, Radius, Components, Principles;
- **Apply to selected screens** as a new generation operation;
- **Compare with app** after connection;
- **Export DESIGN.md** as a portable handoff artifact;
- **Refresh from app** only after source freshness and user review.

### Export and Continue in workspace

Keep the current focused export model. Aiden does not need eight partner buttons.

Recommended Export choices:

- Save selected screen HTML;
- Download project bundle;
- Copy source;
- Export Project Brief;
- Export `DESIGN.md`;
- Continue in workspace.

The Project Brief should contain bounded, user-reviewable material:

- project goal and audience;
- chosen direction and rejected alternatives, if retained;
- screen inventory and prototype links;
- design-language summary;
- responsive expectations;
- accessibility notes;
- revision and content hashes;
- explicit prototype limitations.

Continue in workspace remains a separate primary action because it creates durable engineering state. Its dialog should explain the journey in product terms:

```text
Selected design → isolated implementation task → reviewable source changes
```

Do not merge this with Connect app:

- **Connect app** means inspect and propose reviewed changes to an existing authorized app.
- **Continue in workspace** means graduate a selected prototype revision into a new implementation task.

## Contract changes worth considering

Do not reopen the safe V1 project contract merely to rename UI labels. Add new facts only where product behavior needs durable identity.

### Add or derive

- `primarySurface`: web, app, or unspecified;
- screen status: static, prototype, or connected-preview;
- variant-set identity and membership;
- chosen-direction identity;
- optional project-local design-language binding;
- prototype navigation graph identity;
- last meaningful project activity for library sorting;
- first-success auto-title state so automatic naming happens once and never fights later manual edits.

### Keep unchanged

- `DesignProjectId` as public identity;
- backing chat as an owned relationship, not the product identity;
- stable lineage IDs and immutable media revisions;
- canonical origin per node;
- renderer snapshots as non-authoritative;
- separate artifact and reference-asset stores;
- compare-and-swap mutations;
- no prompts, code, credentials, absolute paths, or capabilities in the project snapshot;
- reviewed connected-source actions;
- bounded, recoverable workspace handoff.

### Consider a resource-shaped internal API

Even without a public MCP server, Design operations should look like resource operations:

- `createDesignProject`;
- `listDesignScreens`;
- `getDesignScreen`;
- `generateDesignScreens`;
- `refineDesignScreens`;
- `generateDesignVariants`;
- `chooseDesignDirection`;
- `getDesignLanguage`;
- `applyDesignLanguage`;
- `buildDesignPrototype`;
- `exportDesignProject`;
- `continueDesignInWorkspace`.

This makes Agent mode, future automations, and UI actions share one precise vocabulary without turning generic chat text into authority.

## Prioritized roadmap

### P0 — Make the current product coherent

1. Fix blank/lazy artboard presentation with durable thumbnails or explicit loading placeholders.
2. Fix the Code inspector disappearing visually.
3. Synchronize selection across conversation cards, canvas, composer, inspector, and history.
4. Rename conversation-card **Open workspace** to **Show on canvas**.
5. Auto-name untouched `Untitled Design` projects after first successful publication.
6. Replace ambiguous device icons with explicit preview/generation semantics.
7. Group current toolbar icons under labeled workflow actions while preserving keyboard-accessible tooltips.

These are mostly projection and interaction changes. They should land before new generation capabilities.

### P1 — Add Explore and Refine

1. Add generation intent to the attended Design append request.
2. Add a first-class variant-set contract and bounded persistence.
3. Add count, creative range, and aspect controls.
4. Add Compare, Choose as direction, and Refine this.
5. Add deterministic next/previous screen navigation and a shortcut sheet.
6. Add a prompt scaffold for initial briefs and targeted refinements.

### P2 — Add project-local Design Language

1. Decouple local design-language creation from Connect app.
2. Define a portable, validated `DESIGN.md` import/export format compatible in spirit with Stitch's open document approach.
3. Record snapshot hash on every generated revision.
4. Add apply-to-selection as a generation operation.
5. Add reviewed compare/merge when a connected app also has extracted tokens.

### P3 — Deepen prototypes and handoff

1. Add a bounded screen-link/prototype graph.
2. Generate and verify missing states.
3. Add structured interaction and accessibility checks.
4. Export a Project Brief.
5. Improve Continue in workspace with chosen-direction and prototype-graph context.
6. Consider opt-in local QR preview only after its network and lifecycle contract is explicit.

### Later, only if demand supports it

- predictive attention heatmaps;
- animation generation;
- marketing and store-asset generation;
- Figma export;
- a public/local Design MCP server;
- hosted sharing or multiplayer collaboration;
- one-click deployment partners.

These are attractive menu items but should not outrank a reliable design-to-code loop.

## Acceptance criteria

### Project and selection

- A new user can create a project and start prompting without inventing a name first.
- A first successful design gives an untouched project a useful title.
- Every durable screen shows a thumbnail or explicit loading/error state on reopen.
- Selecting the same screen from any surface produces the same primary lineage and active revision.
- Reloading, navigating away, and restarting restore canvas position, selected direction, and active revision without mounting stale executable documents.

### Explore and refine

- Two to five generated variations are durably grouped and remain individually inspectable.
- Creative range and selected aspects are visible in history.
- Choosing a direction never deletes other options.
- Refining a variation creates a revision or child direction from an exact immutable base.
- A stale base cannot replace a newer active revision.

### Preview and code

- Preview, Code, and History remain visibly usable at 390, 700, 1000, and 1280 px.
- Code source cannot resize or displace its panel.
- Code, copy, save, compare, and bundle export refer to the same revision identity.
- Missing or corrupt source shows a recovery action instead of placeholder prose.
- A static screen is not labeled interactive until prototype verification succeeds.

### Design Language

- A Prototype-only project can create, view, apply, import, and export a design language.
- Every model turn previews exactly which design-language snapshot will be sent.
- A stale connected snapshot is never labeled current.
- Import/export rejects credentials, paths, executable content, oversized values, unknown machine fields, and invalid encodings.
- User-authored Markdown rationale cannot grant tools, source, network, or workspace authority.

### Handoff

- The selected direction, revision, responsive intent, references, and design-language hash are visible before handoff.
- Cancel and crash behavior retain the existing journaled recovery guarantees.
- No hidden prompt, transcript, credential, absolute path, or internal store document enters the workspace packet.
- Repository edits still require normal review even when Design mode is treated as full-access for its own local project.

## Metrics to watch

Prefer workflow metrics that can be computed locally and kept content-free:

- time from project creation to first successfully rendered screen;
- percentage of projects still named `Untitled Design` after first success;
- percentage of generation turns with an explicit screen target;
- variation sets that produce a chosen direction;
- number of refinements after choosing a direction;
- successful project reopen with all expected thumbnails available;
- Preview/Code/History open success and recovery rates;
- exports and Continue in workspace handoffs per project;
- handoff tasks that reach a reviewed source diff;
- recovery prompts and repair success by bounded reason code.

Do not collect prompt text, generated source, screenshots, repository paths, or design content for these metrics.

## What not to copy

- Do not make cloud storage or a Google account the default ownership model.
- Do not use model brand names as the primary design workflow.
- Do not turn generated HTML into an implied production codebase.
- Do not add a long partner-export menu before core export is reliable.
- Do not rely on external CDNs in offline Aiden export bundles.
- Do not let imported design prose become agent authority.
- Do not equate device translation with resizing.
- Do not hide selection and command semantics behind icons alone.
- Do not let connecting an app silently change existing prototype origins.
- Do not make public sharing, multiplayer, or deployment prerequisites for strong local design work.

## Recommended decision

Aiden does not need a paradigm pivot. The architecture has already pivoted correctly from chat-owned artifacts to durable local Design Projects.

The next pivot is experiential:

```text
from: a capable canvas attached to a conversation
to:   a screen-centered design studio with conversation as one tool
```

Stitch demonstrates how much clearer the loop becomes when exploration, refinement, preview, and handoff are explicit. Aiden should adopt that clarity while keeping its stronger local ownership, immutable history, truthful source boundary, and reviewed path into real code.

## Source index

- [Stitch documentation home](https://stitch.withgoogle.com/docs)
- [Everything you need to know to design with Stitch](https://stitch.withgoogle.com/docs/learn/overview/)
- [Effective Prompting](https://stitch.withgoogle.com/docs/learn/prompting/)
- [Device Types](https://stitch.withgoogle.com/docs/learn/device-types/)
- [Design Modes](https://stitch.withgoogle.com/docs/learn/design-modes/)
- [Using Variations](https://stitch.withgoogle.com/docs/learn/variants/)
- [Controls & Hotkeys](https://stitch.withgoogle.com/docs/learn/controls/)
- [Stitch via MCP](https://stitch.withgoogle.com/docs/mcp/setup/)
- [What is DESIGN.md?](https://stitch.withgoogle.com/docs/design-md/overview/)
- [Import DESIGN.md from your codebase](https://stitch.withgoogle.com/docs/design-md/get-instructions/)
