import assert from "node:assert/strict";
import test from "node:test";
import { isStudioPath, studioFeatureForPath } from "./studio-routes.js";

test("studio routes match their root and nested paths only", () => {
  assert.equal(studioFeatureForPath("/design"), "designStudio");
  assert.equal(studioFeatureForPath("/design/project-1"), "designStudio");
  assert.equal(studioFeatureForPath("/images"), "createImages");
  assert.equal(studioFeatureForPath("/images/workflow-1"), "createImages");
  for (const pathname of ["/", "/designs", "/imagesx", "/chat/design", "/settings", "/bots/images"]) {
    assert.equal(studioFeatureForPath(pathname), null, pathname);
    assert.equal(isStudioPath(pathname), false, pathname);
  }
});
