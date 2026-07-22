import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPUTER_USE_NOTICE_PERMANENT_KEY,
  COMPUTER_USE_NOTICE_SESSION_KEY,
  COMPUTER_USE_NOTICE_VERSION,
  clearComputerUseNoticeDismissal,
  isComputerUseNoticeDismissed,
  persistComputerUseNoticeDismissal,
  shouldShowComputerUseNotice,
  type ComputerUseNoticeStorage,
} from "./computer-use-notice.js";

function memoryStorage(initial: Record<string, string> = {}): ComputerUseNoticeStorage {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

test("shows the notice only for an opted-in chat that has not dismissed it", () => {
  assert.equal(shouldShowComputerUseNotice(false, false), false);
  assert.equal(shouldShowComputerUseNotice(true, false), true);
  assert.equal(shouldShowComputerUseNotice(true, true), false);
});

test("supports session-only dismissal", () => {
  const permanent = memoryStorage();
  const session = memoryStorage();

  persistComputerUseNoticeDismissal("session", permanent, session);

  assert.equal(isComputerUseNoticeDismissed(permanent, session), true);
  assert.equal(
    session.getItem(COMPUTER_USE_NOTICE_SESSION_KEY),
    String(COMPUTER_USE_NOTICE_VERSION),
  );
  assert.equal(permanent.getItem(COMPUTER_USE_NOTICE_PERMANENT_KEY), null);
});

test("supports permanent dismissal", () => {
  const permanent = memoryStorage();
  const session = memoryStorage();

  persistComputerUseNoticeDismissal("permanent", permanent, session);

  assert.equal(isComputerUseNoticeDismissed(permanent, session), true);
  assert.equal(
    permanent.getItem(COMPUTER_USE_NOTICE_PERMANENT_KEY),
    String(COMPUTER_USE_NOTICE_VERSION),
  );
  assert.equal(session.getItem(COMPUTER_USE_NOTICE_SESSION_KEY), null);
});

test("a stale dismissal version does not hide revised privacy copy", () => {
  const staleVersion = String(COMPUTER_USE_NOTICE_VERSION - 1);
  const permanent = memoryStorage({ [COMPUTER_USE_NOTICE_PERMANENT_KEY]: staleVersion });
  const session = memoryStorage({ [COMPUTER_USE_NOTICE_SESSION_KEY]: staleVersion });

  assert.equal(isComputerUseNoticeDismissed(permanent, session), false);
});

test("restoring the notice clears both dismissal scopes", () => {
  const currentVersion = String(COMPUTER_USE_NOTICE_VERSION);
  const permanent = memoryStorage({ [COMPUTER_USE_NOTICE_PERMANENT_KEY]: currentVersion });
  const session = memoryStorage({ [COMPUTER_USE_NOTICE_SESSION_KEY]: currentVersion });

  clearComputerUseNoticeDismissal(permanent, session);

  assert.equal(isComputerUseNoticeDismissed(permanent, session), false);
});
