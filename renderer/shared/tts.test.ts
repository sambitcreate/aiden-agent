import assert from "node:assert/strict";
import test from "node:test";
import {
  TTS_LIMITS,
  defaultTtsSettings,
  normalizeTtsSettings,
  parseTtsSettingsPatch,
  parseTtsSourceRef,
  parseTtsStartRequest,
} from "./tts.js";

test("defaults are disabled, saved-google, flash, no voice, code off", () => {
  const defaults = defaultTtsSettings();
  assert.equal(defaults.version, 1);
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.credentialSource, "saved-google");
  assert.equal(defaults.model, "gemini-3.8-flash-tts");
  assert.equal(defaults.selectedVoice, null);
  assert.deepEqual(defaults.reading, { inlineCode: true, fencedCode: false });
  assert.equal(defaults.audioRetention, "session");
});

test("normalizeTtsSettings canonicalizes corrupt and future documents", () => {
  assert.deepEqual(normalizeTtsSettings(undefined), defaultTtsSettings());
  assert.deepEqual(normalizeTtsSettings("junk"), defaultTtsSettings());
  assert.deepEqual(normalizeTtsSettings({ version: 1, enabled: "yes" }), defaultTtsSettings());
  const normalized = normalizeTtsSettings({
    version: 1,
    enabled: true,
    model: "not-a-model",
    credentialSource: "elsewhere",
    delivery: { preset: "wild", note: "x".repeat(500) },
    selectedVoice: { kind: "mystery", localVoiceId: "" },
  });
  assert.equal(normalized.model, "gemini-3.8-flash-tts");
  assert.equal(normalized.credentialSource, "saved-google");
  assert.equal(normalized.delivery.preset, "neutral");
  assert.equal(normalized.delivery.note.length, TTS_LIMITS.deliveryNoteMaxChars);
  assert.equal(normalized.selectedVoice, null);
});

test("normalizeTtsSettings keeps valid selections intact", () => {
  const settings = normalizeTtsSettings({
    version: 1,
    enabled: true,
    credentialSource: "dedicated",
    model: "gemini-3.8-flash-lite-tts",
    selectedVoice: { kind: "replicated", localVoiceId: "voices/abc" },
    delivery: { preset: "calm", note: "slower" },
    reading: { inlineCode: false, fencedCode: true },
  });
  assert.equal(settings.enabled, true);
  assert.equal(settings.credentialSource, "dedicated");
  assert.equal(settings.model, "gemini-3.8-flash-lite-tts");
  assert.deepEqual(settings.selectedVoice, {
    kind: "replicated",
    localVoiceId: "voices/abc",
  });
  assert.deepEqual(settings.delivery, { preset: "calm", note: "slower" });
  assert.deepEqual(settings.reading, { inlineCode: false, fencedCode: true });
});

test("patch parsing rejects unknown, malformed, and secret-bearing fields", () => {
  assert.throws(() => parseTtsSettingsPatch({ apiKey: "AIza..." }), /Invalid TTS settings patch/u);
  assert.throws(() => parseTtsSettingsPatch({ enabled: "true" }), /Invalid TTS enabled/u);
  assert.throws(() => parseTtsSettingsPatch({ model: "gpt-5" }), /Invalid TTS model/u);
  assert.throws(
    () => parseTtsSettingsPatch({ selectedVoice: { kind: "prebuilt", localVoiceId: "" } }),
    /Invalid TTS voice/u,
  );
  assert.throws(
    () => parseTtsSettingsPatch({ delivery: { preset: "angry", note: "" } }),
    /Invalid TTS delivery/u,
  );
  assert.throws(
    () => parseTtsSettingsPatch({ reading: { inlineCode: "yes", fencedCode: false } }),
    /Invalid TTS reading/u,
  );
  const parsed = parseTtsSettingsPatch({ enabled: false });
  assert.deepEqual(parsed, { enabled: false });
});

test("source reference and start request parsing is strict", () => {
  assert.throws(() => parseTtsSourceRef({}), /Invalid TTS source/u);
  assert.throws(
    () => parseTtsSourceRef({ chatId: "c", messageId: "m", sourceRevision: "" }),
    /Invalid TTS source/u,
  );
  const ref = parseTtsSourceRef({
    chatId: "chat-1",
    messageId: "msg-1",
    sourceRevision: "rev-1",
  });
  assert.deepEqual(ref, { chatId: "chat-1", messageId: "msg-1", sourceRevision: "rev-1" });
  assert.throws(
    () =>
      parseTtsStartRequest({
        requestId: "",
        source: ref,
        settingsRevision: "r",
      }),
    /Invalid TTS start/u,
  );
  const request = parseTtsStartRequest({
    requestId: "req",
    source: ref,
    settingsRevision: "r",
  });
  assert.equal(request.requestId, "req");
  assert.equal(request.source.chatId, "chat-1");
});

test("limits stay aligned with the reviewed plan values", () => {
  assert.equal(TTS_LIMITS.sourceMaxBytes, 1024 * 1024);
  assert.equal(TTS_LIMITS.transcriptMaxBytes, 128 * 1024);
  assert.equal(TTS_LIMITS.segmentTargetMinChars, 600);
  assert.equal(TTS_LIMITS.segmentTargetMaxChars, 1200);
  assert.equal(TTS_LIMITS.segmentMaxBytes, 4 * 1024);
  assert.equal(TTS_LIMITS.audioReadMaxBytes, 64 * 1024);
  assert.equal(TTS_LIMITS.sessionAudioMaxBytes, 32 * 1024 * 1024);
  assert.equal(TTS_LIMITS.previewMaxChars, 400);
});

test("request parsing rejects extra transcript fields, nested secrets and inherited patches", () => {
  const source = { chatId: "chat", messageId: "message", sourceRevision: "rev" };
  const request = { requestId: "request", source, settingsRevision: "rev" };
  assert.throws(() => parseTtsStartRequest({ ...request, transcript: "renderer text" }));
  assert.throws(() => parseTtsSourceRef({ ...source, content: "renderer text" }));
  assert.throws(() =>
    parseTtsSettingsPatch({ delivery: { preset: "calm", note: "", apiKey: "secret" } }),
  );
  assert.throws(() =>
    parseTtsSettingsPatch({
      reading: { inlineCode: true, fencedCode: false, transcript: "extra" },
    }),
  );
  assert.throws(() => parseTtsSettingsPatch(Object.create({ enabled: true })));
  assert.throws(() => parseTtsSettingsPatch(JSON.parse('{"__proto__":{"enabled":true}}')));
});
