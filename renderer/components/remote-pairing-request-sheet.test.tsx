import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PairingRequestSheetBody,
  formatPairingMatchCode,
  nextPairingRequest,
  pairingRequestSecondsLeft,
} from "./remote-pairing-request-sheet.js";
import { AcceptConnectionRequestsField } from "./settings/remote-connection-requests-field.js";
import type { AidenRemotePairingRequestPrompt } from "../shared/aiden-remote.js";

const NOW = Date.parse("2026-10-03T12:00:00.000Z");

function prompt(
  requestId: string,
  overrides: Partial<AidenRemotePairingRequestPrompt> = {},
): AidenRemotePairingRequestPrompt {
  return {
    requestId,
    deviceName: "Travel MacBook",
    deviceType: "mac",
    transport: "lan",
    matchCode: "042917",
    expiresAt: new Date(NOW + 90_000).toISOString(),
    approving: false,
    ...overrides,
  };
}

test("the match code is grouped for reading aloud without changing its digits", () => {
  assert.equal(formatPairingMatchCode("042917"), "042 917");
  assert.equal(formatPairingMatchCode("042917").replace(" ", ""), "042917");
  assert.equal(formatPairingMatchCode("12345"), "12345");
});

test("the sheet offers the oldest unanswered live request and counts the rest", () => {
  const prompts = [
    prompt("pairreq_first"),
    prompt("pairreq_expired", { expiresAt: new Date(NOW - 1).toISOString() }),
    prompt("pairreq_second"),
    prompt("pairreq_third"),
  ];
  const fresh = nextPairingRequest(prompts, new Set(), NOW);
  assert.equal(fresh.current?.requestId, "pairreq_first");
  assert.equal(fresh.waiting, 2);

  const afterAnswer = nextPairingRequest(prompts, new Set(["pairreq_first"]), NOW);
  assert.equal(afterAnswer.current?.requestId, "pairreq_second");
  assert.equal(afterAnswer.waiting, 1);

  // Once its countdown runs out, a request is never offered for a decision.
  const later = nextPairingRequest(prompts, new Set(), NOW + 90_000);
  assert.equal(later.current, null);
  assert.equal(later.waiting, 0);
  assert.equal(pairingRequestSecondsLeft("not a date", NOW), 0);
  assert.equal(pairingRequestSecondsLeft(new Date(NOW + 1_500).toISOString(), NOW), 2);
});

test("a request stays on screen and alone shows as busy until its answer settles", () => {
  const prompts = [prompt("pairreq_first"), prompt("pairreq_second")];

  const settling = nextPairingRequest(prompts, new Set(), NOW, "pairreq_first");
  assert.equal(settling.current?.requestId, "pairreq_first");
  assert.equal(settling.busy, true);
  assert.equal(settling.waiting, 1);

  // Its countdown running out mid-answer does not swap in the next request.
  const lateSettle = nextPairingRequest(prompts, new Set(), NOW + 90_000, "pairreq_first");
  assert.equal(lateSettle.current?.requestId, "pairreq_first");
  assert.equal(lateSettle.waiting, 0);

  // Once settled, the next request is offered and is not shown as busy.
  const next = nextPairingRequest(prompts, new Set(["pairreq_first"]), NOW, null);
  assert.equal(next.current?.requestId, "pairreq_second");
  assert.equal(next.busy, false);

  // A request the host is still approving shows as busy even without a local answer.
  const hostApproving = nextPairingRequest([prompt("pairreq_third", { approving: true })], new Set(), NOW);
  assert.equal(hostApproving.busy, true);

  // A pending answer for a request the host no longer lists falls back to the queue.
  const gone = nextPairingRequest([prompt("pairreq_second")], new Set(), NOW, "pairreq_first");
  assert.equal(gone.current?.requestId, "pairreq_second");
  assert.equal(gone.busy, false);
});

test("the approval sheet shows the code to compare, where the request came from and its deadline", () => {
  const html = renderToStaticMarkup(
    <PairingRequestSheetBody
      prompt={prompt("pairreq_first", { deviceType: "linux", transport: "tailscale" })}
      secondsLeft={75}
      waiting={2}
    />,
  );
  assert.match(html, /aria-label="Match code 0 4 2 9 1 7"/u);
  assert.match(html, />042 917</u);
  assert.match(html, /Linux · Tailscale/u);
  assert.match(html, /role="timer"[^>]*>Expires in 1:15</u);
  assert.match(html, /2 more requests are waiting\./u);

  const single = renderToStaticMarkup(
    <PairingRequestSheetBody prompt={prompt("pairreq_first")} secondsLeft={9} waiting={0} />,
  );
  assert.match(single, /Mac · Same network/u);
  assert.match(single, /Expires in 0:09/u);
  assert.doesNotMatch(single, /more request/u);
});

test("the connection request toggle reflects the saved choice and locks while saving", () => {
  const on = renderToStaticMarkup(
    <AcceptConnectionRequestsField accept hostLabel="Mac" busy={false} disabled={false} onChange={() => {}} />,
  );
  assert.match(on, /role="switch"[^>]*aria-checked="true"|aria-checked="true"[^>]*role="switch"/u);
  assert.match(on, /aria-label="Accept connection requests"/u);
  assert.match(on, /ask to control this Mac/u);
  assert.doesNotMatch(on, /disabled=""/u);

  const saving = renderToStaticMarkup(
    <AcceptConnectionRequestsField
      accept={false}
      hostLabel="computer"
      busy
      disabled
      onChange={() => {}}
    />,
  );
  assert.match(saving, /aria-checked="false"/u);
  assert.match(saving, /role="switch"[^>]*disabled=""|disabled=""[^>]*role="switch"/u);
  assert.match(saving, /ask to control this computer/u);
});
