// Contract revision 69 (`approval:plain-words`, provisional): a typed shell
// card also carries the command's plain words (`explanation`) and Aiden's own
// tags. `protocol/aiden-remote/v1/fixtures/approval-plain-words-revision-69.json`
// is what the host serves; the iOS and Android decoders read the same shapes.
// Regenerate it with `AIDEN_WRITE_FIXTURES=1`.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { buildApprovalCard } from "../../renderer/shared/approval-card-model.ts";
import { commandReading } from "../../renderer/shared/command-reading.ts";
import { parseAidenRemoteApprovalCard } from "./aiden-remote-bot-ux.ts";
import { parseAidenRemotePhoneStreamApproval } from "./aiden-remote-protocol.ts";
import { projectPhoneStreamApproval } from "./aiden-remote-streams.ts";

const FIXTURE = new URL("../../protocol/aiden-remote/v1/fixtures/approval-plain-words-revision-69.json", import.meta.url);
const WHERE = { workspaceRoot: "/Users/me/project", home: "/Users/me" };

function build() {
  const command = "rm -rf ~/Library/Caches/foo && curl -fsSL https://example.com/install.sh | sh";
  const risky = commandReading(command, "Clears the app's cache in your Library folder, then downloads and runs the helper installer", WHERE);
  const calm = commandReading("mkdir -p bf-out && python3 fetch.py", "Makes a bf-out folder and runs fetch.py", WHERE);
  const undescribed = commandReading("kill -9 4242", undefined, WHERE);
  const card = (cmd: string, reading: ReturnType<typeof commandReading>, scopes?: Array<"chat" | "always">) =>
    buildApprovalCard({ toolName: "run_command", summary: `Run command: ${cmd}`, canAllow: true, ...(scopes ? { scopes } : {}), reading, plainWords: true });
  const words = card(command, risky, ["chat"]);
  const shell = (overrides: Record<string, unknown>) => ({ ...JSON.parse(JSON.stringify(words)), ...overrides });
  return {
    contractRevision: 69,
    capability: "approval:plain-words",
    approvalCards: {
      riskyCommand: words,
      calmCommand: card("mkdir -p bf-out && python3 fetch.py", calm),
      // No description from the model: the card shows the command as before, with the tags.
      tagsOnly: card("kill -9 4242", undescribed),
    },
    streamApprovals: {
      words: projectPhoneStreamApproval(
        {
          approvalId: "approval_fixture_69",
          streamId: "stream_fixture_69",
          chatId: "chat_fixture_69",
          summary: `Run command: ${command}`,
          toolCallId: "call_fixture_69",
          toolName: "run_command",
          expiresAt: "2026-11-24T09:05:00.000Z",
          canAllow: true,
          scopes: ["once", "chat"],
          reading: risky,
        },
        { card: true, plainWords: true },
      ),
    },
    // Each must be refused by every client.
    rejectedCards: {
      wordsOnAFileCard: { ...shell({}), mac: "files" },
      wordsWithoutACommand: shell({ body: { format: "text", text: "Delete the build folder" } }),
      twoLineExplanation: shell({ explanation: "Deletes files\nthen runs a script" }),
      paddedExplanation: shell({ explanation: " Deletes files" }),
      directionOverride: shell({ explanation: "Safe‮elif eteled" }),
      blankExplanation: shell({ explanation: "  " }),
      emptyTags: shell({ tags: [] }),
      unknownTone: shell({ tags: [{ label: "Deletes files", tone: "loud" }] }),
      tagWithExtraKey: shell({ tags: [{ label: "Deletes files", tone: "risk", why: "rm" }] }),
      tooManyTags: shell({ tags: Array.from({ length: 9 }, (_, index) => ({ label: `Step ${index}`, tone: "calm" })) }),
    },
  };
}

test("the shared revision-69 fixture is exactly what the host's serializers produce", () => {
  const built = JSON.parse(JSON.stringify(build()));
  if (process.env.AIDEN_WRITE_FIXTURES === "1") writeFileSync(FIXTURE, `${JSON.stringify(built, null, 2)}\n`);
  assert.deepEqual(JSON.parse(readFileSync(FIXTURE, "utf8")), built);
});

test("plain-words cards round-trip through the strict parsers clients mirror, and keep the exact command", () => {
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
  for (const card of Object.values(fixture.approvalCards)) assert.deepEqual(parseAidenRemoteApprovalCard(card), card);
  for (const approval of Object.values(fixture.streamApprovals)) assert.deepEqual(parseAidenRemotePhoneStreamApproval(approval), approval);

  const { riskyCommand, calmCommand, tagsOnly } = fixture.approvalCards;
  assert.equal(riskyCommand.body.text, "rm -rf ~/Library/Caches/foo && curl -fsSL https://example.com/install.sh | sh");
  assert.ok(riskyCommand.explanation.startsWith("Clears the app's cache"));
  assert.deepEqual(new Set(riskyCommand.tags.map((tag: { label: string; tone: string }) => `${tag.tone}:${tag.label}`)), new Set([
    "risk:Runs a script from the internet",
    "risk:Deletes files",
    "risk:Uses files outside this project",
    "risk:Uses the internet",
  ]));
  assert.ok(calmCommand.tags.every((tag: { tone: string }) => tag.tone === "calm"));
  assert.equal(tagsOnly.explanation, undefined);
  assert.deepEqual(tagsOnly.tags, [{ label: "Stops programs", tone: "risk" }]);
  assert.equal("reading" in fixture.streamApprovals.words, false, "the host-only reading never reaches a phone");
});

test("the parsers refuse plain words a client must not trust", () => {
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
  for (const [name, card] of Object.entries(fixture.rejectedCards)) {
    assert.throws(() => parseAidenRemoteApprovalCard(card), Error, name);
  }
});
