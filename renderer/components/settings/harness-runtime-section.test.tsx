import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { AcpHarnessStatus } from "../../shared/acp-harness.js";
import { HarnessRuntimeSection, runtimeFocusTarget } from "./harness-runtime-section.js";

function render(runtime: AcpHarnessStatus["runtime"], busy = false): string {
  return renderToStaticMarkup(
    <HarnessRuntimeSection
      providerId="antigravity"
      label="Google Antigravity"
      status={{ providerId: "antigravity", runtime, signedIn: false, busy }}
    />,
  );
}

test("before installing, the size, source and consent are stated next to Install", () => {
  const html = render({ status: "not_installed", version: "1.3.0", downloadBytes: 111_456_962, requiredBytes: 900_000_000 });
  assert.match(html, /downloads 111 MB from dl\.google\.com and needs about 900 MB free\./u);
  assert.match(html, /Nothing is\s+downloaded until you choose Install\./u);
  assert.match(html, />Install Google Antigravity</u);
  assert.doesNotMatch(html, /role="progressbar"/u);
});

test("installing shows determinate progress and a cancel action, but no install button", () => {
  const html = render({ status: "installing", phase: "downloading", receivedBytes: 55_000_000, totalBytes: 110_000_000 });
  assert.match(html, /role="progressbar"[^>]*aria-valuenow="50"/u);
  assert.match(html, />Cancel installation</u);
  assert.doesNotMatch(html, />Install Google Antigravity</u);
});

test("an installed runtime can be removed, except while chats are using it", () => {
  const idle = render({ status: "installed", version: "1.3.0" });
  assert.match(idle, /Version 1\.3\.0 installed\./u);
  assert.match(idle, /<button[^>]*>.*Remove runtime/u);
  assert.doesNotMatch(idle, /<button[^>]*disabled=""[^>]*>[^<]*<svg[^>]*>.*Remove runtime/u);
  assert.doesNotMatch(idle, /Stop running/u);
  const busy = render({ status: "installed", version: "1.3.0" }, true);
  // A disabled button cannot show a tooltip, so the reason is visible text the button points at.
  const describedBy = busy.match(/<button[^>]*disabled=""[^>]*aria-describedby="([^"]+)"/u)?.[1];
  assert.ok(describedBy, "the disabled Remove button names its reason");
  const reason = busy.match(/<span[^>]*\bid="([^"]+)"[^>]*>([^<]+)</u);
  assert.deepEqual(reason?.slice(1), [describedBy, "Stop running Google Antigravity chats first."]);
  assert.doesNotMatch(busy, /title="/u);
});

test("unsupported computers get an explanation and no actions; failures offer a retry", () => {
  const unsupported = render({ status: "unsupported", message: "Google does not publish this runtime for this computer." });
  assert.match(unsupported, /does not publish this runtime/u);
  assert.doesNotMatch(unsupported, /<button/u);
  const failed = render({ status: "failed", message: "Installation cancelled. Nothing was changed.", downloadBytes: 1, requiredBytes: 2 });
  assert.match(failed, /Installation cancelled/u);
  assert.match(failed, />Retry installation</u);
  const update = render({ status: "update_available", installedVersion: "1.2.1", version: "1.3.0", downloadBytes: 1, requiredBytes: 2 });
  assert.match(update, />Update Google Antigravity</u);
});

test("when an action unmounts, focus moves to the control that replaced it", () => {
  // Install → installing: the install button is gone, Cancel is the only action.
  assert.equal(runtimeFocusTarget({ status: "installing", phase: "downloading" }, false), "cancel");
  // Cancel or failure: Retry replaces Cancel; removal: Install replaces Remove.
  assert.equal(runtimeFocusTarget({ status: "failed", message: "Installation cancelled." }, false), "install");
  assert.equal(runtimeFocusTarget({ status: "not_installed" }, false), "install");
  assert.equal(runtimeFocusTarget({ status: "update_available" }, false), "install");
  // Finished install: Remove runtime. Confirming: Keep, the safe choice. Backing out: Remove runtime again.
  assert.equal(runtimeFocusTarget({ status: "installed" }, false), "remove");
  assert.equal(runtimeFocusTarget({ status: "installed" }, true), "keep");
  // No actions at all: the section itself, so focus stays in the dialog.
  assert.equal(runtimeFocusTarget({ status: "unsupported" }, false), "section");
});

test("the section can hold focus itself when it has no action left to offer", () => {
  const html = render({ status: "unsupported", message: "Not available for this computer." });
  assert.match(html, /<div[^>]*role="group"[^>]*tabindex="-1"/u);
});

test("a status read that fails says so and offers a retry instead of checking forever", () => {
  const props = { providerId: "antigravity", label: "Google Antigravity", status: null };
  const checking = renderToStaticMarkup(<HarnessRuntimeSection {...props} />);
  assert.match(checking, /Checking the <!-- -->Google Antigravity<!-- --> runtime…|Checking the Google Antigravity runtime…/u);
  assert.doesNotMatch(checking, /<button/u);
  const failed = renderToStaticMarkup(
    <HarnessRuntimeSection {...props} loadError="The app is restarting." onRetry={() => undefined} />,
  );
  assert.match(failed, /role="alert"[^>]*>Couldn&#x27;t check the Google Antigravity runtime\. The app is restarting\.</u);
  assert.match(failed, /<button[^>]*>.*Try again<\/button>/u);
  assert.doesNotMatch(failed, /Checking the/u);
});
