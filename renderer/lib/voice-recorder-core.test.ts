import assert from "node:assert/strict";
import test from "node:test";

import {
  microphoneCaptureErrorMessage,
  MICROPHONE_PERMISSION_OFF_MESSAGE,
} from "./voice-recorder-core.js";

test("microphone capture errors preserve actionable device and permission causes", () => {
  assert.equal(
    microphoneCaptureErrorMessage({ name: "NotAllowedError" }),
    MICROPHONE_PERMISSION_OFF_MESSAGE,
  );
  assert.equal(
    microphoneCaptureErrorMessage({ name: "SecurityError" }),
    MICROPHONE_PERMISSION_OFF_MESSAGE,
  );
  assert.match(
    microphoneCaptureErrorMessage({ name: "NotFoundError" }),
    /No microphone was found/u,
  );
  assert.match(
    microphoneCaptureErrorMessage({ name: "NotReadableError" }),
    /other apps using it/u,
  );
  assert.match(
    microphoneCaptureErrorMessage({ name: "AbortError" }),
    /interrupted/u,
  );
  assert.match(
    microphoneCaptureErrorMessage(new Error("raw device detail")),
    /could not start/u,
  );
  assert.match(
    microphoneCaptureErrorMessage(
      Object.defineProperty({}, "name", {
        get() {
          throw new Error("untrusted getter detail");
        },
      }),
    ),
    /could not start/u,
  );
});

test("permission recovery tells users that macOS requires an app restart", () => {
  assert.match(MICROPHONE_PERMISSION_OFF_MESSAGE, /restart Aiden/u);
});
