import assert from "node:assert/strict";
import { test } from "node:test";
import { createDesignFrameNavigationGuard, type GuardedFrame } from "./frame-navigation.js";

const PAGE = "aiden-design://grant-a/design/hero.html";

function frame(id: number, url: string): GuardedFrame {
  return { frameTreeNodeId: id, url };
}

test("a design frame stays on its own aiden-design host", () => {
  const guard = createDesignFrameNavigationGuard();
  // The canvas points a new iframe at a workspace page.
  assert.equal(guard.allows({ isMainFrame: false, frame: frame(7, ""), url: PAGE }), true);
  const showing = frame(7, PAGE);

  assert.equal(guard.allows({ isMainFrame: false, frame: showing, url: `${PAGE}?v=2` }), true, "a newer version");
  assert.equal(
    guard.allows({ isMainFrame: false, frame: showing, url: "aiden-design://grant-a/design/about.html" }),
    true,
    "a link to another workspace page",
  );
  for (const url of [
    "https://example.com/escape",
    "http://localhost:5173/",
    "about:blank",
    "data:text/html,<p>hi</p>",
    "file:///etc/hosts",
    "aiden-design://grant-b/design/hero.html",
  ]) {
    assert.equal(guard.allows({ isMainFrame: false, frame: showing, url }), false, url);
  }
});

test("a design frame that has not shown its page yet still cannot leave for the web", () => {
  const guard = createDesignFrameNavigationGuard();
  assert.equal(guard.allows({ isMainFrame: false, frame: frame(3, "about:blank"), url: PAGE }), true);
  // Still about:blank: the first page has not committed.
  assert.equal(guard.allows({ isMainFrame: false, frame: frame(3, "about:blank"), url: "https://example.com/" }), false);
  assert.equal(guard.allows({ isMainFrame: false, frame: frame(3, "about:blank"), url: `${PAGE}?v=1` }), true);
});

test("other frames and the window itself are left alone, and a reload forgets old frames", () => {
  const guard = createDesignFrameNavigationGuard();
  assert.equal(guard.allows({ isMainFrame: true, frame: frame(1, "app://index.html"), url: "https://example.com/" }), true);
  assert.equal(
    guard.allows({ isMainFrame: false, frame: frame(9, "aiden-genui://artifact/1"), url: "aiden-genui://artifact/2" }),
    true,
  );
  assert.equal(guard.allows({ isMainFrame: false, frame: null, url: "https://example.com/" }), true);

  guard.allows({ isMainFrame: false, frame: frame(4, ""), url: PAGE });
  assert.equal(guard.allows({ isMainFrame: false, frame: frame(4, ""), url: "about:blank" }), false);
  guard.reset();
  assert.equal(guard.allows({ isMainFrame: false, frame: frame(4, ""), url: "about:blank" }), true);
});
