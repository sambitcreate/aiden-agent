import assert from "node:assert/strict";
import test from "node:test";
import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  OLDER_BROWSER_SCREENSHOT_NOTE,
  OLDER_COMPUTER_SCREENSHOT_NOTE,
  SCREENSHOT_TRIM_LIMITS,
  trimScreenshots,
} from "./screenshot-trimming.js";

const MIB = 1024 * 1024;

function call(id: string, toolName: string): Message {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: toolName, arguments: {} }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "faux",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: 0,
  };
}

function screenshot(id: string, toolName: string, data: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName,
    content: [{ type: "text", text: `${id} done` }, { type: "image", data, mimeType: "image/png" }],
    isError: false,
    timestamp: 0,
  };
}

/** Each screenshot's data, in the order the request carries them. */
function carried(messages: readonly Message[]): string[] {
  return messages.flatMap((message) =>
    message.role === "toolResult" ? message.content.flatMap((part) => (part.type === "image" ? [part.data] : [])) : [],
  );
}

/**
 * Feeds screenshots one step at a time, as a tool loop does, and returns each
 * step's request together with the steps whose request edited an earlier message.
 */
function run(datas: readonly string[], toolName = "computer_use") {
  const transcript: Message[] = [{ role: "user", content: "Watch the screen.", timestamp: 0 }];
  const requests: Array<readonly Message[]> = [];
  const edited: number[] = [];
  datas.forEach((data, index) => {
    transcript.push(call(`shot-${index}`, toolName), screenshot(`shot-${index}`, toolName, data));
    // Each request is its own array, as the agent loop builds one per step.
    const request = trimScreenshots([...transcript]);
    const previous = requests[requests.length - 1];
    if (previous && previous.some((message, at) => JSON.stringify(message) !== JSON.stringify(request[at]))) {
      edited.push(index + 1);
    }
    requests.push(request);
  });
  return { requests, edited, transcript };
}

test("screenshots are cut only at the count limit, and each cut keeps the newest three", () => {
  const datas = Array.from({ length: 24 }, (_, index) => `png-${index + 1}`);
  const { requests, edited, transcript } = run(datas);
  // Kept screenshots grow to eight; the ninth cuts them to three, so the next
  // cut lands six screenshots later.
  assert.deepEqual(edited, [9, 15, 21], "earlier messages change only at a cut");
  for (const step of edited) {
    assert.deepEqual(carried(requests[step - 1]!), datas.slice(step - 3, step), `step ${step} keeps the newest three`);
  }
  for (let step = 1; step <= 8; step += 1) {
    assert.deepEqual(carried(requests[step - 1]!), datas.slice(0, step), `step ${step} carries every screenshot`);
  }
  assert.deepEqual(carried(requests[13]!), datas.slice(6, 14), "between cuts the kept ones only grow");

  // A cut screenshot always becomes the same bytes: the note in its place,
  // with the result's own text kept.
  const last = requests[requests.length - 1]!;
  const first = last[2] as ToolResultMessage;
  assert.deepEqual(first.content, [{ type: "text", text: "shot-0 done" }, { type: "text", text: OLDER_COMPUTER_SCREENSHOT_NOTE }]);
  assert.equal(JSON.stringify(trimScreenshots(transcript)), JSON.stringify(last), "the same history renders the same request");
  assert.equal(carried(transcript).length, 24, "the transcript keeps every screenshot");
});

test("screenshots are cut at the byte limit too, down to what fits in the smaller budget", () => {
  // Six MiB each: the fifth passes 25 MiB and the cut keeps the newest two
  // (three would pass 15 MiB). Two more fit, and the eighth passes 25 MiB again.
  const datas = Array.from({ length: 9 }, (_, index) => String(index).repeat(6 * MIB));
  const { requests, edited } = run(datas, "browser_snapshot");
  assert.deepEqual(edited, [5, 8]);
  for (const step of edited) {
    const kept = carried(requests[step - 1]!);
    assert.deepEqual(kept, datas.slice(step - 2, step), `step ${step} keeps the newest two`);
    assert.ok(kept.join("").length <= SCREENSHOT_TRIM_LIMITS.keepBytes);
    assert.ok(kept.length <= SCREENSHOT_TRIM_LIMITS.keepImages);
  }
  const notes = requests[8]!.flatMap((message) =>
    message.role === "toolResult" ? message.content.filter((part) => part.type === "text" && part.text === OLDER_BROWSER_SCREENSHOT_NOTE) : [],
  );
  assert.equal(notes.length, 6, "each cut browser screenshot leaves the browser note");
});

test("the newest screenshot stays even when it alone passes both limits", () => {
  const huge = "x".repeat(30 * MIB);
  const { requests, edited } = run(["small-1", "small-2", huge]);
  assert.deepEqual(edited, [3]);
  assert.deepEqual(carried(requests[2]!), [huge]);
});

test("the screenshot tools share one count, and other images are neither counted nor cut", () => {
  const transcript: Message[] = [
    { role: "user", content: [{ type: "text", text: "Look." }, { type: "image", data: "person", mimeType: "image/png" }], timestamp: 0 },
  ];
  const tools = ["computer_use", "browser_snapshot", "computer"];
  for (let index = 0; index < 9; index += 1) {
    const toolName = tools[index % tools.length]!;
    transcript.push(call(`shot-${index}`, toolName), screenshot(`shot-${index}`, toolName, `png-${index}`));
    transcript.push(call(`read-${index}`, "read_file"), screenshot(`read-${index}`, "read_file", `file-${index}`));
  }
  const request = trimScreenshots(transcript);
  assert.deepEqual(
    carried(request).filter((data) => data.startsWith("png-")),
    ["png-6", "png-7", "png-8"],
    "nine screenshots across three tools make one cut",
  );
  assert.equal(carried(request).filter((data) => data.startsWith("file-")).length, 9);
  assert.equal(request[0], transcript[0], "the person's image is untouched");
  const notes = request.flatMap((message) =>
    message.role === "toolResult" ? message.content.flatMap((part) => (part.type === "text" && part.text.startsWith("An older") ? [`${message.toolName}: ${part.text}`] : [])) : [],
  );
  assert.deepEqual(notes, [
    `computer_use: ${OLDER_COMPUTER_SCREENSHOT_NOTE}`,
    `browser_snapshot: ${OLDER_BROWSER_SCREENSHOT_NOTE}`,
    `computer: ${OLDER_COMPUTER_SCREENSHOT_NOTE}`,
    `computer_use: ${OLDER_COMPUTER_SCREENSHOT_NOTE}`,
    `browser_snapshot: ${OLDER_BROWSER_SCREENSHOT_NOTE}`,
    `computer: ${OLDER_COMPUTER_SCREENSHOT_NOTE}`,
  ]);
});
