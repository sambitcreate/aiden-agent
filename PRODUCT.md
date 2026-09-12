# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

## Users

Aiden Agent is for people who work with code and local project files on a Mac and want an AI collaborator that can chat, inspect a chosen workspace, and take explicitly permitted actions. They may use hosted or local models and need to understand which workspace, model, and access level are active without leaving the conversation.

## Product Purpose

Aiden Agent provides a private, native-feeling workspace for model conversations and agentic coding tasks. Success means the interface recedes behind the work: starting a chat is immediate, context and permissions stay legible, settings are understandable without documentation, and local-versus-network boundaries remain clear.

## Positioning

Aiden combines a native-feeling desktop workspace with Pi-based agent extensibility, user-selected local or hosted models, and explicit workspace and permission boundaries. The paired native iOS and Android clients extend the Mac-owned workspace rather than creating separate sources of authority.

## Operating Context

The primary application is an Electron desktop app for macOS. People work in folder-backed workspaces, use chats and Bots, review files and Git changes, run tools with explicit permissions, and may connect native iOS or Android clients to a paired Mac for remote access.

## Capabilities and Constraints

- Supports local and hosted model providers without making one provider the product authority.
- Keeps workspace, Bot, permission, model, and local-versus-network scope explicit at the point of action.
- Treats the Mac as the authority for workspace files, credentials, agent execution, durable memory, and paired-client operations.
- Requires deliberate user actions for external connections, sensitive permissions, and destructive or durable mutations.

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
