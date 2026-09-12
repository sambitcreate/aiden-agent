import assert from "node:assert/strict";
import test from "node:test";
import { DesignLivePreviewAuthority } from "./design-live-preview-authority.js";

test("live Design preview authority is exact and revoked with its generation", () => {
  const authority = new DesignLivePreviewAuthority();
  const grant = {
    streamId: "turn:one",
    documentId: "document:one",
    chatId: "chat:one",
    mediaId: "design:one",
  };
  authority.grant(grant);
  authority.grant({ ...grant, mediaId: "design:two" });

  assert.equal(authority.hasStream(grant.streamId), true);
  assert.equal(authority.hasChat(grant.chatId), true);
  assert.equal(authority.allows(grant), true);
  assert.equal(authority.allows({ ...grant, mediaId: "design:two" }), true);
  assert.equal(authority.allows({ ...grant, documentId: "document:other" }), false);
  assert.equal(authority.allows({ ...grant, chatId: "chat:other" }), false);
  assert.equal(authority.allows({ ...grant, streamId: "turn:other" }), false);
  assert.equal(authority.allows({ ...grant, mediaId: "design:other" }), false);

  authority.revokeStream(grant.streamId);
  assert.equal(authority.hasStream(grant.streamId), false);
  assert.equal(authority.hasChat(grant.chatId), false);
  assert.equal(authority.allows(grant), false);
});

test("a stream cannot be rebound to another preview owner", () => {
  const authority = new DesignLivePreviewAuthority();
  authority.grant({
    streamId: "turn:one",
    documentId: "document:one",
    chatId: "chat:one",
    mediaId: "design:one",
  });
  assert.throws(
    () =>
      authority.grant({
        streamId: "turn:one",
        documentId: "document:two",
        chatId: "chat:one",
        mediaId: "design:two",
      }),
    /changed owners/u,
  );
});

test("a detached stream resumes only for its original document and chat", () => {
  const authority = new DesignLivePreviewAuthority();
  const grant = {
    streamId: "turn:one",
    documentId: "document:one",
    chatId: "chat:one",
    mediaId: "design:one",
  };
  authority.grant(grant);

  assert.equal(authority.suspendStream(grant.streamId, "document:other"), false);
  assert.equal(authority.allows(grant), true);
  assert.equal(authority.suspendStream(grant.streamId, grant.documentId), true);
  assert.equal(authority.hasChat(grant.chatId), true);
  assert.equal(authority.allows(grant), false);
  authority.grant({ ...grant, mediaId: "design:two" });
  assert.equal(
    authority.allows({ ...grant, mediaId: "design:two" }),
    false,
    "new staged media does not silently restore a detached document capability",
  );
  assert.equal(
    authority.resumeStream({ ...grant, documentId: "document:other" }),
    false,
    "another renderer document cannot claim the detached stream",
  );
  assert.equal(
    authority.resumeStream({ ...grant, chatId: "chat:other" }),
    false,
    "another chat cannot claim the detached stream",
  );
  assert.equal(authority.resumeStream(grant), true);
  assert.equal(authority.allows(grant), true);
  assert.equal(authority.allows({ ...grant, mediaId: "design:two" }), true);

  assert.equal(authority.suspendStream(grant.streamId, grant.documentId), true);
  authority.revokeStream(grant.streamId);
  assert.equal(authority.resumeStream(grant), false);
  assert.equal(authority.allows(grant), false);
});

test("detach then revisit before the first artifact preserves suspension through the first grant", () => {
  const authority = new DesignLivePreviewAuthority();
  const admission = {
    streamId: "turn:before-artifact",
    documentId: "document:one",
    chatId: "chat:one",
  };
  authority.admitStream(admission);
  assert.equal(authority.suspendStream(admission.streamId, admission.documentId), true);
  assert.equal(authority.resumeStream(admission), true);

  const firstArtifact = { ...admission, mediaId: "design:first" };
  authority.grant(firstArtifact);
  assert.equal(authority.allows(firstArtifact), true);
  assert.equal(authority.allows({ ...firstArtifact, documentId: "document:other" }), false);
  assert.equal(authority.allows({ ...firstArtifact, chatId: "chat:other" }), false);

  authority.revokeStream(admission.streamId);
  assert.equal(authority.allows(firstArtifact), false);
});
