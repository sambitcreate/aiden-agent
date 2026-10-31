# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

## Users

Aiden Agent is for people who work with code and local project files on a Mac or Linux desktop and want an AI collaborator that can chat, inspect a chosen workspace, and take explicitly permitted actions. They may use hosted or local models and need to understand which workspace, model, and access level are active without leaving the conversation.

## Product Purpose

Aiden Agent provides a private, native-feeling workspace for model conversations and agentic coding tasks. Success means the interface recedes behind the work: starting a chat is immediate, context and permissions stay legible, settings are understandable without documentation, and local-versus-network boundaries remain clear.

## Positioning

Aiden combines a native-feeling desktop workspace with Pi-based agent extensibility, user-selected local or hosted models, and explicit workspace and permission boundaries. The paired native iOS and Android clients extend the desktop-owned workspace rather than creating separate sources of authority.

## Operating Context

The primary application is an Electron desktop app for macOS and Linux. People work in folder-backed workspaces or in No workspace chats (global settings, with a hidden per-chat folder Aiden manages), use chats and Bots, review files and Git changes, run tools with explicit permissions, and may connect native iOS or Android clients to a paired desktop for remote access.

## Capabilities and Constraints

- Supports local and hosted model providers without making one provider the product authority.
- Keeps workspace, Bot, permission, model, and local-versus-network scope explicit at the point of action.
- Treats the desktop host as the authority for workspace files, credentials, agent execution, durable memory, and paired-client operations.
- Requires deliberate user actions for external connections, sensitive permissions, and destructive or durable mutations.
- A Bot can suggest a one-time or recurring routine in its chat. The person accepts the proposal before Aiden schedules future turns in that Bot's durable conversation; execution depends on the desktop scheduler and current Bot access. Each due fire is saved before the schedule advances and reconciled with Pi after a restart; the Bot's Routines page shows pending or overdue work. On the desktop, routines heal themselves: a failed run records why, a passing failure is retried (5 then 20 minutes later), a sign-in or access problem raises one "Needs you" card, three same-kind failures in a row pause the routine with a Resume card, a pre-fire check about 30 minutes ahead catches problems early (Profile → Health), stuck runs are stopped (routines) or flagged (attended turns), and a result that claims a failed step worked says so. See [docs/bot-routines.md](docs/bot-routines.md#when-a-routine-fails). Bots are also proactive without being pushy: Advanced → Interruptions sets quiet hours (default 10 PM–7 AM) and a daily limit (default 5); a dated promise becomes a follow-up suggestion; Not now asks why and the Bot backs off after repeated declines; and Profile → When something happens adds desktop-only routines that run on a file change in the Bot's folder or when their link is called on the local network or Tailscale. See [docs/bot-routines.md](docs/bot-routines.md#proactive-without-being-pushy). In a turn the person started, a Bot can also set itself up to 3 one-time wake-ups, 1 minute to 24 hours ahead, without a card; each shows in the chat and the Bot's routines with Cancel, and Advanced → Chat switches them off per Bot (on the desktop; see [docs/bot-routines.md](docs/bot-routines.md#wake-ups-a-bot-sets-for-itself)). Bots also learn, visibly: a routine's recent runs can yield one suggested lesson (kept only with Keep this), a correction becomes a how-to lesson with Undo, a Bot can propose a skill for a procedure you liked (a skill in the Bot's folder never loads without your approval), nearly full memory is tidied with Undo, and Profile → What I've learned lists it all with Undo. Background learning is capped per Bot per day. See [docs/bot-routines.md](docs/bot-routines.md#bots-that-learn).
- Coding follow-through keeps a workspace chat moving after an answer ends: background jobs report when they end, a followed pull request reports failed checks, conflicts and comments from people with write access until it merges, and `/until` reruns a check after each answer, five checks at most. News arrives as compact notice cards; command output, CI logs and comments are fenced as data, and a chat starts at most six unattended follow-up answers an hour. macOS and Linux desktop; see [docs/coding-follow-through.md](docs/coding-follow-through.md).
- Bots ask you to sign in in their own browser; the model never sees your password.
- A provider's usage limit makes a reply wait, never switch to another model; limits that last days and billing problems fail at once with the reset time. Spending limits are the owner's: each chat, each Bot's month and each routine run can stop at a dollar amount counted from API-key requests only, and only the person can allow more (on the Mac or a paired phone). See [docs/usage-limits-and-spending.md](docs/usage-limits-and-spending.md).
- In chats with Web Search on, the agent can read a public web page. Opt-in extract mode, set up with the person's own Cloudflare account, returns only the named values it asks for, each with the page line it came from; a value that is not on the page comes back as a guess, never as read.
- Bot computers (Apple silicon): an opt-in macOS VM per Bot, which the Bot sees and uses with its own `computer` tool (screenshots and clicks, each step with a stated intent the rules read) and `computer_shell` tool, on routine runs too. The Bot panel's Computer tab shows it live with the Bot's avatar where it last pointed; the person's first click or key, or Take over, stops the Bot's current action until Give back, and Float over chat keeps the screen in view. Element control (Aiden's pinned cua-driver in the base computer, allowed once for Accessibility and Screen Recording and inherited by every Bot computer made from it) lets the Bot read an app's buttons and fields and click them by number, and the rules then also read the element acted on; skipping it keeps screen-only Bots. A Bot can ask the person to sign in on its own computer: Open hands the person the computer with Safari at the site, the Bot's computer tools wait, and the password never reaches the model. The onboarding tour introduces Bot computers only where they exist. See [docs/bot-computers.md](docs/bot-computers.md).

The standalone CLI can explicitly migrate its Bot host to the shared durable session core. Migration is opt-in, preserves legacy data, and advertises only supported session, routine, preset and memory endpoints; see [CLI durable Bots](docs/cli-durable-bots.md). Private verification receipts and workflow lesson drafts are evaluation infrastructure; Bot learning (lessons, corrections, skill proposals) is a separate, person-approved feature with its own store.

## Brand Commitments

Quiet, capable, and trustworthy. The product should feel at home on macOS, with the restraint and task focus of the Codex and ChatGPT desktop apps while retaining Aiden's own workspace and privacy model.

Avoid a generic web dashboard inside a desktop shell, ornamental cards, feature-promoting empty states, oversized or detached control regions, and settings copy that repeats labels without explaining consequences. Do not add decorative buttons, suggestions, or features to make an empty surface look busier.

## Product Principles

- Keep the conversation primary; navigation and configuration should remain available without competing for attention.
- Show essential context at the point of action, especially workspace, model, permission, privacy, and error state.
- Prefer familiar macOS and high-quality AI-tool conventions over novel controls.
- Use progressive disclosure so simple workflows stay simple while advanced capabilities remain discoverable.
- Refine the existing product vocabulary before introducing another visual or interaction pattern.

## Accessibility & Inclusion

Target WCAG 2.2 AA for text and controls. Preserve keyboard access, visible focus, semantic labels, sufficient contrast, reduced-motion behavior, and non-color-only communication. Keep dense desktop UI readable at the app's supported window sizes and system appearance settings.
