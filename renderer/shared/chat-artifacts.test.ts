import assert from "node:assert/strict";
import test from "node:test";
import { parseChatArtifactEventV1, parseChatArtifactV1 } from "./chat-artifacts.js";
import { MAX_HTML_ARTIFACT_BYTES } from "./generative-ui.js";

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
