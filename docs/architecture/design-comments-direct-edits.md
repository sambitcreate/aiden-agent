# Design comments and bounded direct edits

Status: Implemented. Comments, direct-edit IPC, pointer/keyboard controls, durable connected review,
prototype revision creation, and exact immutable undo are wired.

## Authority boundary

Comments and direct-manipulation gestures are context. They never grant repository, command,
network, Git, preview-session, or artifact-write authority.

A comment target is durable only when all of these identities are present:

- Design Project ID;
- artboard lineage ID;
- immutable revision media ID;
- an exact, single-match selector identity; and
- either the generated artifact content hash or a relative, source-version/range/preimage-hash
  connected-source identity.

An ephemeral React Grab selection or preview capability is insufficient and is never persisted.
When the current immutable revision or full source binding changes, the store marks the older
comment stale. Stale comments remain visible and can be resolved or reopened, but are never
silently retargeted.

The comment store is main-owned, atomic, schema- and byte-bounded, and written with mode `0600`.
All writes use both database revision CAS and, for existing comments, comment revision CAS.
Corrupt or unsupported on-disk data makes the store unavailable rather than allowing a later
write to replace it.

## Literal edit matrix

The direct-edit core accepts only:

- margin, padding, and gap spacing literals;
- width and height literals;
- enumerated alignment values;
- semantic CSS custom-property token names for color roles;
- border-radius literals; and
- bounded static plain text.

CSS expressions, URLs, raw colors, arbitrary properties, negative values, markup-like text,
localized or dynamic text, rich text, computed classes, ambiguous selector/component matches,
and repeated literal-definition matches fail closed. Proof facts must report exactly one selector,
component, and literal definition match.

Within one accepted gesture envelope, the proposal and undo identities are deterministic. That
gives the integration coordinator one idempotency key and one future undo record. A renderer IPC
retry is a new attended gesture with a newly minted gesture ID; it is not deduplicated against a
previous ambiguous request.

## Origin-specific output

Prototype edits produce a `prototype-revision-request` pinned to the base media ID and artifact
hash. The request instructs an artifact adapter to create a new immutable revision; the core never
overwrites artifact bytes.

The main adapter re-reads the committed source, verifies its SHA-256 identity, proves one exact
`data-aiden-id` target and one literal inline definition, and derives a deterministic new media ID
from the proposal. It stages the new bytes, CAS-appends the lineage in the Design Project, appends
the chat artifact idempotently, and only then commits the staged bytes. A pre-CAS failure discards
only the exact pending row. A post-CAS interruption deliberately leaves the pending row for the
existing startup recovery path, so retries and restarts converge on one immutable revision.

Connected-app edits produce a `designer-action-request` carrying the relative path, full source
version, exact range, preimage, and independently verified preimage hash. The core never writes
source. An integration adapter must turn that semantic literal edit into one exact replacement,
then submit it through the existing Designer Action review/apply/undo transaction. Full permission
must not bypass that review.

The connected adapter resolves the live source-selection capability again, compares every path,
version, range, preimage, hash, and selector fact with the proposal, and parses the canonical TSX.
Only a single literal inline JSX style property or a single plain JSX text node is rewritten. The
caller must also provide a trusted source-graph proof that the enclosing component has one use;
missing or ambiguous graph evidence fails closed. The result is submitted to
`SourceDesignerActionService.propose`, so apply and undo retain the same review transaction as
every other Designer Action.

## Intentional limitations

The
prototype adapter intentionally supports only literal inline HTML style declarations and plain
text nodes. The connected adapter intentionally supports only literal inline JSX style objects and
plain JSX text nodes. Stylesheets, classes, spreads, expressions, component indirection, localized
text, rich children, ambiguous selectors, and repeated definitions fail closed instead of being
guessed. Color changes additionally require the main caller to resolve the token from the current
trusted design-system snapshot; renderer-reported token names are never sufficient authority.
