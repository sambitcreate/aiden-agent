import assert from "node:assert/strict";
import test from "node:test";
import { parseChatArtifactEventV1, parseChatArtifactV1, parseHtmlArtifactPlacements } from "./chat-artifacts.js";
import { MAX_HTML_ARTIFACT_BYTES } from "./generative-ui.js";

const UI_VISUAL = {
  version: 1,
  kind: "ui",
  id: "ui-1",
  toolCallId: "call-2",
  title: "Board",
  catalogVersion: 1,
  tree: { t: "Visual", k: "0", c: [{ t: "Text", k: "0.0", c: [{ t: "#text", k: "0.0.0", s: "Hi" }] }] },
  fallbackText: "Hi",
};

test("native visual events carry a validated visual", () => {
  assert.deepEqual(parseChatArtifactEventV1({ version: 1, operation: "ui", visual: UI_VISUAL }), {
    version: 1,
    operation: "ui",
    visual: UI_VISUAL,
  });
  assert.deepEqual(parseChatArtifactEventV1({ version: 1, operation: "ui_draft", toolCallId: "call-2", visual: UI_VISUAL }), {
    version: 1,
    operation: "ui_draft",
    toolCallId: "call-2",
    visual: UI_VISUAL,
  });
  for (const bad of [
    { version: 1, operation: "ui", visual: { ...UI_VISUAL, tree: undefined } },
    { version: 1, operation: "ui", visual: UI_VISUAL, extra: 1 },
    { version: 1, operation: "ui_draft", visual: UI_VISUAL },
    { version: 1, operation: "ui_draft", toolCallId: "", visual: UI_VISUAL },
  ]) {
    assert.equal(parseChatArtifactEventV1(bad), undefined, JSON.stringify(bad));
  }
});

const IMAGE = {
  version: 1 as const,
  kind: "image" as const,
  attachment: {
    id: "att-1",
    name: "preview.png",
    mimeType: "image/png",
    kind: "image" as const,
    size: 1,
    data: "AA==",
  },
};

const HTML = {
  version: 1 as const,
  kind: "html" as const,
  id: "html-1",
  title: "Dependencies",
  mimeType: "text/html" as const,
  size: 12,
  mediaId: "media-1",
};

test("parseChatArtifactV1 accepts html artifacts without weakening image admission", () => {
  assert.deepEqual(parseChatArtifactV1(IMAGE), IMAGE);
  assert.deepEqual(parseChatArtifactV1(HTML), HTML);
});

test("html parser rejects extra keys, paths, and oversized payloads", () => {
  assert.equal(parseChatArtifactV1({ ...HTML, path: "/tmp/x.html" }), undefined);
  assert.equal(parseChatArtifactV1({ ...HTML, html: "<p>x</p>" }), undefined);
  assert.equal(parseChatArtifactV1({ ...HTML, title: " leading" }), undefined);
  assert.equal(parseChatArtifactV1({ ...HTML, title: "bad\ntitle" }), undefined);
  assert.equal(parseChatArtifactV1({ ...HTML, mediaId: "../etc/passwd" }), undefined);
  assert.equal(parseChatArtifactV1({ ...HTML, size: MAX_HTML_ARTIFACT_BYTES + 1 }), undefined);
  assert.equal(parseChatArtifactV1({ ...HTML, mimeType: "text/plain" }), undefined);
});

test("mutated image payloads still fail closed after the html kind exists", () => {
  assert.equal(parseChatArtifactV1({ ...IMAGE, extra: true }), undefined);
  assert.equal(
    parseChatArtifactV1({
      ...IMAGE,
      attachment: { ...IMAGE.attachment, data: "<script>" },
    }),
    undefined,
  );
  assert.equal(
    parseChatArtifactV1({
      version: 1,
      kind: "image",
      id: "x",
      title: "nope",
      mimeType: "text/html",
      size: 1,
      mediaId: "media-1",
    }),
    undefined,
  );
});

test("unknown kinds and mixed image/html shapes drop", () => {
  assert.equal(parseChatArtifactV1({ ...HTML, kind: "widget" }), undefined);
  assert.equal(
    parseChatArtifactV1({
      version: 1,
      kind: "html",
      attachment: IMAGE.attachment,
    }),
    undefined,
  );
  assert.equal(
    parseChatArtifactEventV1({
      version: 1,
      operation: "present",
      artifact: { ...HTML, extra: true },
    }),
    undefined,
  );
  assert.deepEqual(
    parseChatArtifactEventV1({ version: 1, operation: "present", artifact: HTML }),
    { version: 1, operation: "present", artifact: HTML },
  );
});

const PLACED_MEDIA = "a".repeat(64);

test("placements keep valid entries and drop malformed ones individually", () => {
  assert.equal(parseHtmlArtifactPlacements(undefined), undefined);
  assert.equal(parseHtmlArtifactPlacements("nope"), undefined);
  assert.deepEqual(
    parseHtmlArtifactPlacements([
      { mediaId: PLACED_MEDIA, toolCallId: "call_1" },
      { mediaId: PLACED_MEDIA, toolCallId: "call_dup" },
      { mediaId: "bad id with spaces", toolCallId: "call_2" },
      { mediaId: "b".repeat(64), toolCallId: "" },
      { mediaId: "d".repeat(64), toolCallId: "call_4" },
    ]),
    [
      { mediaId: PLACED_MEDIA, toolCallId: "call_1" },
      { mediaId: "d".repeat(64), toolCallId: "call_4" },
    ],
  );
  assert.equal(parseHtmlArtifactPlacements([{ mediaId: "x", toolCallId: 1 }]), undefined);
});

test("placements carry a wide layout and tolerate fields from newer builds", () => {
  assert.deepEqual(
    parseHtmlArtifactPlacements([
      { mediaId: "a".repeat(64), toolCallId: "call_1", layout: "wide" },
      { mediaId: "b".repeat(64), toolCallId: "call_2", layout: "column" },
      { mediaId: "c".repeat(64), toolCallId: "call_3", layout: "fullscreen" },
      { mediaId: "d".repeat(64), toolCallId: "call_4", futureField: { any: true } },
    ]),
    [
      { mediaId: "a".repeat(64), toolCallId: "call_1", layout: "wide" },
      { mediaId: "b".repeat(64), toolCallId: "call_2" },
      { mediaId: "c".repeat(64), toolCallId: "call_3" },
      { mediaId: "d".repeat(64), toolCallId: "call_4" },
    ],
  );
});

test("present and draft events may mark a visual wide", () => {
  const src = `aiden-genui://preview/${"e".repeat(64)}`;
  const present = parseChatArtifactEventV1({
    version: 1, operation: "present", artifact: HTML, toolCallId: "call_1", src, layout: "wide",
  });
  assert.equal(present?.operation === "present" && present.layout, "wide");
  const draft = parseChatArtifactEventV1({
    version: 1, operation: "draft", toolCallId: "call_1", title: "Chart", src, layout: "wide",
  });
  assert.equal(draft?.operation === "draft" && draft.layout, "wide");
  // Any other layout reads as the reading column; it never hides the visual.
  const narrowPresent = parseChatArtifactEventV1({ version: 1, operation: "present", artifact: HTML, layout: "huge" });
  assert.equal(narrowPresent?.operation, "present");
  assert.equal(narrowPresent && "layout" in narrowPresent, false);
  const narrowDraft = parseChatArtifactEventV1({ version: 1, operation: "draft", toolCallId: "call_1", src, layout: "column" });
  assert.deepEqual(narrowDraft, { version: 1, operation: "draft", toolCallId: "call_1", src });
});

test("draft events carry a preview URL for one tool call and nothing else", () => {
  const src = `aiden-genui://preview/${"a".repeat(64)}`;
  assert.deepEqual(
    parseChatArtifactEventV1({ version: 1, operation: "draft", toolCallId: "call_1", title: "Chart", src }),
    { version: 1, operation: "draft", toolCallId: "call_1", title: "Chart", src },
  );
  assert.deepEqual(
    parseChatArtifactEventV1({ version: 1, operation: "draft", toolCallId: "call_1", src }),
    { version: 1, operation: "draft", toolCallId: "call_1", src },
  );
  assert.deepEqual(
    parseChatArtifactEventV1({ version: 1, operation: "draft_end", toolCallId: "call_1" }),
    { version: 1, operation: "draft_end", toolCallId: "call_1" },
  );
  for (const bad of [
    { version: 1, operation: "draft", toolCallId: "call_1", src: "https://example.com/x" },
    { version: 1, operation: "draft", toolCallId: "call_1", src: `${src}?x=1` },
    { version: 1, operation: "draft", toolCallId: "", src },
    { version: 1, operation: "draft", toolCallId: "call_1", src, html: "<p>" },
    { version: 1, operation: "draft", toolCallId: "call_1", title: " padded", src },
    { version: 1, operation: "draft_end", toolCallId: "call_1", src },
  ]) {
    assert.equal(parseChatArtifactEventV1(bad), undefined, JSON.stringify(bad));
  }
});

test("present events may carry a ready preview URL and nothing else", () => {
  const src = `aiden-genui://preview/${"b".repeat(64)}`;
  const parsed = parseChatArtifactEventV1({ version: 1, operation: "present", artifact: HTML, toolCallId: "call_1", src });
  assert.equal(parsed?.operation === "present" && parsed.src, src);
  assert.equal(
    parseChatArtifactEventV1({ version: 1, operation: "present", artifact: HTML, toolCallId: "call_1", src: "https://x.test/a" }),
    undefined,
  );
  assert.equal(
    parseChatArtifactEventV1({ version: 1, operation: "present", artifact: HTML, src: "<p>html</p>" }),
    undefined,
  );
});

test("present events may carry the producing toolCallId", () => {
  const parsed = parseChatArtifactEventV1({ version: 1, operation: "present", artifact: HTML, toolCallId: "call_9" });
  assert.equal(parsed?.operation === "present" && parsed.toolCallId, "call_9");
  assert.equal(
    parseChatArtifactEventV1({ version: 1, operation: "present", artifact: HTML, toolCallId: "" }),
    undefined,
  );
  const legacy = parseChatArtifactEventV1({ version: 1, operation: "present", artifact: HTML });
  assert.equal(legacy?.operation === "present" && legacy.toolCallId, undefined);
});
