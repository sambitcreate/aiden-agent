import assert from "node:assert/strict";
import test from "node:test";
import { isStudioPath, studioFeatureForPath } from "./studio-routes.js";

test("studio routes match their root and nested paths only, and the retired Design Studio path is not one", () => {
  assert.equal(studioFeatureForPath("/images"), "createImages");
  assert.equal(studioFeatureForPath("/images/workflow-1"), "createImages");
  for (const pathname of ["/", "/design", "/design/project-1", "/designs", "/imagesx", "/chat/design", "/settings", "/bots/images"]) {
    assert.equal(studioFeatureForPath(pathname), null, pathname);
    assert.equal(isStudioPath(pathname), false, pathname);
  }
});
