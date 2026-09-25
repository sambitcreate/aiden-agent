# Rich link previews for Chats and Bots

Status: Implemented for review

Baseline: `origin/main` at `7a4d9d0bde09d9dbe81b38d2611ac29dc848ee62` on 2026-09-25.

## Goal

Add a small provider icon to supported links and show a compact information card when the user hovers over or keyboard-focuses the link.

The feature applies to regular Chats and Bot conversations. Both routes already render `ChatPane`, which reaches the shared `MessageList`, `SafeMessageBubble`, and Markdown components. The implementation should preserve this shared path rather than add Bot-specific rendering.

The first version covers:

- Persisted assistant messages.
- Streaming assistant responses.
- Plain HTTP and HTTPS links in user message bubbles.
- GitHub.
- GitLab.
- Google Drive, Docs, Sheets, and Slides.
- SharePoint and supported OneDrive links.
- Box.
- Notion.
- Slack.
- Microsoft Teams.
- Outlook Email and Calendar.

Unsupported links continue to render as ordinary links.

## Product contract

Each supported link keeps its original visible label and underline. A small local provider icon sits beside the label without preventing long link text from wrapping.

The hover card shows only information that Aiden can safely derive from the URL:

- Provider name and icon.
- Resource type.
- Human-readable resource identifier when the URL contains one.
- A safe hostname and path summary.
- A short note that selecting the link opens it.

Examples include `sambitcreate/aiden-agent, pull request #247`, `group/project, merge request #42`, `Google Sheet`, `Notion page`, `Slack message`, and `Outlook calendar event`.

If the URL does not contain a readable title, show the resource type and a shortened identifier. Do not invent a title.

The initial release does not fetch a URL during rendering or hover. Remote titles, authors, statuses, message excerpts, and document owners require a separate authenticated metadata phase.

## Provider registry and URL parsing

Add a pure parser, suggested at `renderer/lib/rich-link.ts`, with an extensible provider registry. Each provider entry defines:

- Exact trusted hostnames and narrowly scoped hostname patterns.
- A local icon identifier.
- Supported resource paths.
- A parser for the resource kind and safe labels.
- An optional future metadata resolver identifier.

Use a bounded descriptor such as:

```ts
interface RichLinkDescriptor {
  provider: RichLinkProvider;
  resourceKind: string;
  primaryLabel: string;
  secondaryLabel?: string;
  safeDisplayUrl: string;
}
```

The classifier must:

- Accept HTTP and HTTPS only.
- Parse with `URL`.
- Normalize hostnames before matching.
- Reject lookalike suffixes such as `github.com.example.com`.
- Decode path segments defensively.
- Bound every generated label.
- Exclude usernames, passwords, query parameters, and fragments from displayed metadata.
- Return `null` for malformed, relative, or unsupported links.

Self-hosted GitHub and GitLab instances remain ordinary links until Aiden has an explicit trusted-host configuration.

Cover these resource shapes where the provider exposes a stable URL form:

- GitHub repositories, pull requests, issues, commits, releases, actions, discussions, and files.
- GitLab projects, merge requests, issues, commits, pipelines, and files.
- Google Drive files and folders, plus Docs, Sheets, and Slides.
- SharePoint sites, documents, folders, and supported OneDrive sharing links.
- Box files, folders, and shared links.
- Notion pages and databases on supported Notion domains.
- Slack channel messages and thread links.
- Teams chats, channel messages, meetings, and shared items.
- Outlook mail and calendar deep links.

Opaque or unfamiliar provider URLs should receive a provider-level label such as `Microsoft Teams link` instead of a guessed resource type.

## Renderer implementation

### Shared rich-link component

Add `renderer/components/rich-link.tsx`. Reuse `HoverCard`, `HoverCardTrigger`, and `HoverCardContent` from `renderer/components/ui.tsx`.

The component must:

- Preserve a real `<a href>` element.
- Preserve the original link label and destination.
- Preserve modifier-click and Aiden Browser routing.
- Open on pointer hover and keyboard focus.
- Close on pointer exit, blur, or Escape.
- Keep focus on the link.
- Contain no buttons or other focusable controls in the informational card.
- Use a portal so transcript overflow does not clip the card.
- Use semantic surface, text, and shadow tokens.
- Respect Reduce Motion.
- Fit within narrow window bounds.

Store reviewed icons locally as SVG assets or React components. Do not download provider favicons. Mark decorative icons with `aria-hidden="true"` and verify logo licensing before shipping.

### Assistant Markdown

Update `renderer/components/markdown.tsx` with an opt-in anchor renderer:

- Classify the sanitized `href`.
- Render `RichLink` for recognized providers.
- Render the existing ordinary anchor for unsupported links.
- Leave URLs inside inline code and fenced code blocks unchanged.

Keep the behavior opt-in for transcript messages. `Markdown` is also used by areas such as subagent details, and those surfaces are outside this plan.

### Streaming messages

Pass the same rich-link option through `Markdown`, `MarkdownContent`, and `MarkdownInline` in `renderer/components/streaming-markdown-reveal.tsx`.

The same URL must receive the same descriptor before and after the streaming-to-persisted handoff. The handoff must not duplicate a card, briefly downgrade it to a plain link, or restart remote work.

### User messages

User messages currently render as plain text in `renderer/components/message-bubble.tsx`. Add a bounded tokenizer for complete `http://` and `https://` spans.

The tokenizer must:

- Preserve every non-link character exactly.
- Preserve the original message string for the existing copy action.
- Exclude surrounding punctuation from the URL.
- Avoid treating filesystem paths, source locations, email addresses, or code-like text as web links.
- Fall back to plain text if parsing fails.
- Render supported providers through `RichLink`.
- Render other valid web URLs as ordinary anchors.

## Navigation and security

Do not add a custom click action. Rich links must continue through the existing navigation path:

- Aiden Browser interception when the workspace browser is active.
- Existing external-browser handling otherwise.
- Existing Command-click and Control-click behavior.
- Main-process protocol filtering for external navigation.

Never fetch arbitrary page metadata from the renderer or main process as part of the first version. This prevents hover-triggered tracking, credential leakage, server-side request forgery, redirect abuse, and inconsistent latency.

Do not display URL credentials, signed query parameters, Slack timestamps, opaque sharing parameters, or fragments in the card. The real anchor retains its original destination so link behavior does not change.

## Accessibility and interaction

- The link remains the only focus target.
- Keyboard focus reveals the same information as pointer hover.
- Escape closes the preview without moving focus.
- The card does not trap focus.
- The provider icon is decorative.
- Add concise screen-reader context such as `GitHub pull request` without replacing the visible link label.
- Touch devices retain ordinary link activation and do not depend on hover.
- Preserve a visible focus treatment.
- Verify high zoom, increased text size, light mode, dark mode, and narrow chat layouts.

Use the existing compact-popover motion and flatten it under Reduce Motion. Avoid translation or scaling of the inline link itself.

## Performance bounds

Parsing must remain pure and synchronous. Rendering or hovering must not call the network, IPC, a connector, or persistent storage.

Limit rich previews to the first 50 supported links in one message. Render additional links normally. This bounds component state and portaled content for adversarial or generated messages containing hundreds of URLs.

Do not wrap the full link in `inline-flex`, because that prevents long link labels from wrapping. Keep only the icon at a fixed inline size.

## Edge cases

Cover:

- Invalid, relative, and unsupported URLs.
- Uppercase hostnames.
- Internationalized and punycode hostnames.
- Lookalike and suffix-attack domains.
- URLs containing usernames or passwords.
- Signed URLs and secret query parameters.
- Percent-encoded paths and invalid percent escapes.
- Very long URLs or path segments.
- Unicode resource names.
- Links ending in punctuation or balanced parentheses.
- Multiple links with the same destination.
- Hundreds of links in one message.
- URLs split across streaming chunks.
- Markdown links with custom labels.
- Bare GFM autolinks.
- Links inside tables, lists, blockquotes, and headings.
- URLs inside inline code and code fences.
- Nested or malformed Markdown.
- Deleted, private, expired, or authentication-gated resources.
- Hovering while scrolling or switching chats.
- Cards near every viewport edge.
- Streaming and persisted messages overlapping during handoff.

## Blast radius

Direct renderer files:

- `renderer/components/markdown.tsx`
- `renderer/components/message-bubble.tsx`
- `renderer/components/streaming-markdown-reveal.tsx`
- New rich-link component, parser, icons, and focused tests

Conversation surfaces:

- Regular desktop Chats.
- Desktop Bot conversations.
- Persisted and streaming assistant text.
- User message bubbles.

Risks:

- Navigation: replacing an anchor with a button or intercepting clicks can break Aiden Browser routing and external opening.
- Shared Markdown: changing the default anchor renderer can affect subagent results and other Markdown consumers.
- Streaming: partial URLs or the handoff can cause visual churn or duplicate previews.
- Layout: an unbounded card can overflow a narrow chat, and an inline flex link can stop wrapping.
- Performance: large transcripts can create many hover-card roots.
- Privacy: private service links can contain tenant names, file names, message identifiers, or access tokens.

Expected unaffected areas:

- Stored chat message formats and schemas.
- Bot persistence and generation behavior.
- Telegram formatting.
- HTML artifacts and attachments.
- Subagent result Markdown unless later opted in.
- Main-process networking and connector authentication.
- iOS and Android clients because this phase changes no shared transcript or server contract.

## Verification

Add focused tests for:

- Every supported provider and resource type.
- Lookalike domains and malformed URLs.
- Query-string, credential, and fragment redaction.
- Generic-link fallback.
- Settled assistant rendering.
- Streaming assistant rendering.
- Streaming-to-persisted handoff.
- User-message autolinking and exact copy text.
- Icon accessibility and link accessible names.
- Keyboard focus and Escape behavior.
- Existing `href` and navigation semantics.
- No network or IPC during rendering and hover.
- The per-message preview limit.

Register new test files in the applicable `package.json` test script. Run the focused parser/component tests, existing message-bubble and streaming suites, Bot route tests, TypeScript, lint, the applicable renderer suite, and `git diff --check`.

Manual acceptance must cover regular Chat and Bot conversations, persisted and streaming responses, user and assistant messages, pointer and keyboard operation, normal and modifier clicks, narrow and wide windows, light and dark themes, Reduce Motion, long labels, Unicode labels, and multiple supported providers in one paragraph.

## Implemented slice

The renderer-only slice is implemented on `feature/rich-link-previews-plan`:

- A pure, bounded URL classifier covers the listed providers and rejects lookalike domains.
- Regular Chat and Bot user messages autolink HTTP and HTTPS URLs without changing copied text.
- Persisted and streaming assistant Markdown opt into the same rich-link component.
- Other Markdown consumers retain ordinary anchor rendering by default.
- Hover and keyboard focus open the compact card; Escape closes it; the trigger remains a real anchor.
- Display metadata excludes credentials, query parameters, fragments, opaque document identifiers, and Slack timestamps.
- One message can mount at most 50 rich preview triggers, including across streaming Markdown units.
- Rendering and hover perform no network, IPC, connector, or storage work.

Local verification completed on 2026-09-25: 41 focused rich-link and transcript tests, 451 Bot tests, the Chat/slash-command suite, TypeScript, ESLint, CI policy, the production build, and `git diff --check` passed. Hands-on packaged-app and assistive-technology acceptance remains part of PR review.

## Optional authenticated metadata phase

After the URL-only version is stable, provider metadata may be added through existing authorized connections.

That phase requires a main-process broker that:

- Allows only fixed provider API origins.
- Uses an already-authorized connector.
- Rejects loopback and private-network destinations.
- Bounds redirects, time, response bytes, and returned text.
- Treats all returned metadata as untrusted.
- Caches by canonical resource identity with a short expiry.
- Cancels work when the preview or chat closes.
- Shows the URL-derived card immediately.
- Falls back to URL-derived information on permission, network, deleted-resource, or rate-limit errors.

Do not include this metadata broker in the initial renderer-only slice.
