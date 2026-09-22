# Bot-First Aiden On The Go — Phase 3 evidence

Date: August 23, 2026
Status: Complete — Bot turn admission, managed-home execution, exact capability filtering, live narrowing, Remote/Telegram parity, native attachment isolation, and post-remediation reviews passed.

## Delivered boundary

Phase 3 makes the Full/Custom policy selected in Phase 2 effective at runtime. It does not yet expose the complete Remote Bot CRUD/inbox API or canonical avatar store; those remain Phase 4.

- Every Bot turn is admitted against the exact protected Bot, chat, audience, provider, model, policy epoch, managed-home identity, and current capability inventory.
- Bot chats run from their private managed home and receive main-owned system instructions describing the ordinary save location, broader-Mac inspection rule, minimal-change rule, and no-automatic-Git rule.
- Full Access derives from the live ordinary Aiden inventory. Custom Access publishes only the selected Files, shell, MCP connection/tool, Skill, subagent, and other capability subset.
- Removed or changed capabilities disappear from prompt inventory, schemas, explicit invocation, and execution. Active work carries revocable policy and inventory leases, with a fresh check immediately before each controlled effect.
- Provider/model selection is exact and has no silent fallback. Desktop, authenticated Remote, copied chats, and Telegram-bound Bot chats use the same preparation and authority contract.
- Custom shell is withheld when Files is scoped or Off because the current unrestricted shell cannot soundly enforce a file subset. This is reflected honestly in the projected capability view.
- Schedules are unavailable for Bots in this phase because the current delayed scheduler does not persist Bot identity and re-admit live authority at execution time. Exposing it before that lifecycle exists would bypass narrowing.

## Attachment and inventory isolation

Telegram Bot attachments are written by the universal native `aiden-bot-inbox-writer` helper. The helper pins the exact managed home and traverses `.aiden/telegram-inbox/<profile>` only with descriptor-relative `openat`/`mkdirat` operations. It rejects symlinks and replacements, creates an exclusive owner-only leaf, accepts bounded raw binary input, and removes incomplete output on failure. A deterministic replacement test proves that swapping the visible `.aiden` pathname cannot redirect bytes outside the pinned home.

MCP and Skill inventories carry durable resource incarnations rather than relying on display identity. Child MCP execution joins through the fresh durable identity while retaining its process credential fingerprint. Skill content watchers invalidate active leases only for the exact admitted `SKILL.md` directories. Configuration and credential writers publish the warm cache before advancing the process-wide inventory fence.

## Review and remediation

Independent lifecycle, provider, MCP, attachment, and final security reviews exercised the implementation between fix loops. Material issues found and closed included warm-cache publication after a generation fence, incompatible credential fingerprint domains at the child MCP join, provider/model admission occurring after durable input, and parent-path replacement around a Node-only attachment writer. The final lifecycle and security reviews reported no remaining P0, P1, or P2 findings.

## Verification

```text
npm run type-check
PASS

npm run lint
PASS

npm run test:bots
PASS — 351/351

npm run test:bots:coverage
PASS — 351/351; 78.05% aggregate lines; 77.28% branches; 75.27% functions

npm run test:telegram
PASS — 177/177

npm run test:aiden-remote
PASS — 282 passed, 1 environment-only skip; LAN transport spike 7/7

npm run test:aiden-service-boundary
PASS — 70/70

npm run test
PASS — complete repository suite, including native helpers and the Rust computer-use broker

Native helper, signing, and package-verifier suites
PASS — inbox writer 3/3; wrapper/share-image pretests 7/7; signing/package tests 22/22

git diff --check
PASS
```

### Physical iPhone 13 Pro

Phase 3 changes only the Mac-side TypeScript/native runtime and its tests. The Swift client and shared contract bytes verified on the physical iPhone 13 Pro in Phase 2 were unchanged, so this phase did not reinstall or rerun the phone suite. Physical-device verification resumes when Phase 5 changes the Swift domain and Phase 6 ships the Bot UI, including the bottom Search and New Chat controls.

## Gate result

Phase 3 is complete. Phase 4 can now expose authenticated Bot CRUD, access updates, chat creation, bounded inbox/search, and canonical avatar storage on top of the enforced runtime boundary.
