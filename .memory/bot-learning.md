# Bot learning (Bot autonomy Plan C, 2026-10-27, feature/bot-autonomy)

Spec §7. Plan: `docs/superpowers/plans/2026-10-27-bot-autonomy-c-learning.md`.

- **Home skill approval:** `main/services/bot-skill-approvals.ts` (`skill-approvals.json`, keyed by content fingerprint). `bot-skill-inventory.ts` drops unapproved home skills and reports them via `onUnapprovedHomeSkills`, which leads to `bot-skills/proposals-main.ts` and a review card. `bot-file-tool-router.ts` refuses writes into `.aiden/skill(s)`, `.claude/skills` and `.agents`. The CLI does not approve yet.
- **Skill proposals:** `main/services/bot-skills/` (validate, proposals, propose-tool, skill-proposals-main). The `propose_skill` tool is in `UNATTENDED_WITHHELD`. Entries `aiden.skill-proposal` and `-status`; IPC `bots:skillProposals:respond`. Add writes `<home>/.aiden/skills/<name>/SKILL.md` and approves it. Under Custom access the skill is not auto-granted.
- **Lessons:** `renderer/shared/bot-lessons.ts` and `main/services/bot-lessons/` (store, prompt, how-to-tool). Routine lessons are appended to the routine input via `botRoutinePorts().routineNotes`. Bot-wide lessons go into the `aiden-guidance` section.
- **Reflection:** `main/services/bot-learning/routine-reflection.ts`, after every 5 telling runs. Called from `schedule-execution` afterRun, fire-and-forget. Marks are kept in `<profile>/bots/.routine-reflections.json`.
- **History:** `bot-learning/history.ts` (`learning-history.json`, Undo with conflict). **Budget:** `bot-learning/budget.ts` (12 requests, 24,000 tokens per day). **Fingerprint:** `bot-learning/fingerprint.ts`, recorded on `ScheduledRun.fingerprint` through `ports.fingerprint`.
- **Tidy:** `bot-memory/tidy.ts`, run from the memory review's `afterReview`. **Wiring:** `bot-learning/learning-main.ts`. **Page:** `renderer/main/bots/bot-learning-page.tsx`. Chat cards are in `renderer/components/bots/lesson-cards.tsx`.
- **Not yet:** phone surfaces (no `bot:learning`), the onboarding gallery tile, the attended claim chip, and CLI parity.
