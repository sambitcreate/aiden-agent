import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RoutineProposalCard } from "./routine-proposal-card";

afterEach(cleanup);

const PROPOSAL = { name: "Morning brief", label: "Every day at 8:00 AM", prompt: "Brief me." };

function respondingCard(answers: Array<[string, string | undefined]>) {
  return (
    <RoutineProposalCard
      proposal={PROPOSAL}
      status="pending"
      onRespond={async (decision, reason) => {
        answers.push([decision, reason]);
        return { status: "dismissed" };
      }}
    />
  );
}

test("Not now turns the suggestion down at once; the receipt's optional Why not? records one reason", async () => {
  const answers: Array<[string, string | undefined]> = [];
  render(respondingCard(answers));
  assert.ok(screen.getByText("Add a routine?"));
  fireEvent.click(screen.getByRole("button", { name: "Not now" }));
  await waitFor(() => assert.ok(screen.getByText("Not added: Morning brief")));
  assert.deepEqual(answers, [["dismiss", undefined]], "no question stands between Not now and the answer");
  fireEvent.click(screen.getByRole("button", { name: "Why not Morning brief?" }));
  for (const label of ["Not useful", "Already have this", "Something else"]) assert.ok(screen.getByRole("button", { name: label }));
  fireEvent.click(screen.getByRole("button", { name: "Wrong time" }));
  await waitFor(() => assert.ok(screen.getByText("Not added: Morning brief. Noted, thanks.")));
  assert.deepEqual(answers, [["dismiss", undefined], ["dismiss", "wrong_time"]]);
  assert.equal(screen.queryByRole("button", { name: /Why not/u }), null, "a reason is asked for once");
});

test("a card turned down on another device reads Not added with no Why not? here", () => {
  render(<RoutineProposalCard proposal={PROPOSAL} status="dismissed" onRespond={async () => null} />);
  assert.ok(screen.getByText("Not added: Morning brief"));
  assert.equal(screen.queryAllByRole("button").length, 0);
});

test("a schedule card names its timezone, before and after Add", async () => {
  render(
    <RoutineProposalCard
      proposal={{ ...PROPOSAL, timezone: "America/Los_Angeles" }}
      status="pending"
      onRespond={async () => ({ status: "accepted", routineId: "r1" })}
    />,
  );
  assert.ok(screen.getByText("Morning brief · Every day at 8:00 AM · Pacific Time"));
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await waitFor(() => assert.ok(screen.getByText("Added Morning brief · Every day at 8:00 AM · Pacific Time")));
  assert.equal(screen.queryAllByRole("button").length, 0);
});

const LINK_PROPOSAL = {
  name: "Deploy watcher",
  label: "When this routine's link is called",
  prompt: "Summarize the deploy.",
  trigger: { kind: "webhook" as const },
};

test("accepting a link card shows Copy link once, with the profile's guidance", async () => {
  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => void copied.push(text) },
  });
  render(
    <RoutineProposalCard
      proposal={LINK_PROPOSAL}
      status="pending"
      onRespond={async () => ({ status: "accepted", routineId: "r1", link: "https://mac.tail.ts.net:7443/hooks/bot-routines/secret" })}
    />,
  );
  assert.ok(screen.getByText("Deploy watcher · When this routine's link is called"));
  assert.equal(screen.queryByText(/Pacific|Time$/u), null);
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await waitFor(() => assert.ok(screen.getByText(/It is shown only now/u)));
  // The link itself is copied, never printed into the transcript.
  assert.equal(screen.queryByText(/secret/u), null);
  fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
  await waitFor(() => assert.deepEqual(copied, ["https://mac.tail.ts.net:7443/hooks/bot-routines/secret"]));
});

test("a link card accepted while Aiden On The Go is off says how to turn it on", async () => {
  render(
    <RoutineProposalCard
      proposal={LINK_PROPOSAL}
      status="pending"
      onRespond={async () => ({ status: "accepted", routineId: "r1", link: null })}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await waitFor(() => assert.ok(screen.getByText(/Turn on remote access/u)));
  assert.equal(screen.queryByRole("button", { name: "Copy link" }), null);
});

test("a link card added elsewhere offers New link for its routine", async () => {
  const asked: string[] = [];
  render(
    <RoutineProposalCard
      proposal={LINK_PROPOSAL}
      status="accepted"
      routineId="r9"
      onRespond={async () => null}
      onNewLink={async (id) => {
        asked.push(id);
        return "https://mac.local:7443/hooks/bot-routines/next";
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "New link" }));
  await waitFor(() => assert.ok(screen.getByRole("button", { name: "Copy link" })));
  assert.deepEqual(asked, ["r9"]);
});

test("a revised card reads as replaced, with no actions", () => {
  render(
    <RoutineProposalCard
      proposal={{ ...PROPOSAL, timezone: "UTC" }}
      status="dismissed"
      supersededBy="next"
      onRespond={async () => null}
    />,
  );
  assert.ok(screen.getByText("Morning brief · replaced by a newer suggestion"));
  assert.equal(screen.queryByText(/Not added/u), null);
  assert.equal(screen.queryAllByRole("button").length, 0);
});
