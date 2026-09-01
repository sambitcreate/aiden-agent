import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const canvas = readFileSync(new URL("./design-workspace.tsx", import.meta.url), "utf8");
const layout = readFileSync(new URL("../main/chat-layout.tsx", import.meta.url), "utf8");
const handlers = readFileSync(new URL("../../main/handlers/designer.ts", import.meta.url), "utf8");
const main = readFileSync(new URL("../../main/index.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const recovery = readFileSync(new URL("./design-handoff-recovery.tsx", import.meta.url), "utf8");
const directEditService = readFileSync(
  new URL("../../main/services/design-direct-edit-service.ts", import.meta.url),
  "utf8",
);

test("Design routes migrate legacy chats and open projects by durable identity", () => {
  assert.match(layout, /designerApi[\s\S]*?\.openProject\(projectOrLegacyChatId\)/u);
  assert.match(layout, /opened\.id !== projectOrLegacyChatId/u);
  assert.match(layout, /designProject=\{project\}/u);
  assert.match(layout, /designerApi\.listProjects\(\)/u);
});

test("canvas persists exact arrangement, device viewport, flow viewport, and active revisions", () => {
  assert.match(canvas, /project\.canvas\.flowViewport/u);
  assert.match(canvas, /instance\.setViewport\(savedProject\.canvas\.flowViewport\)/u);
  assert.match(canvas, /onMoveEnd=/u);
  assert.match(canvas, /designerApi\.updateProject/u);
  assert.match(canvas, /expectedRevision: currentProject\.revision/u);
  assert.match(canvas, /activeMediaId: data\.artifact\.mediaId/u);
  assert.match(canvas, /lineage:\$\{data\.group\.revisions\[0\]!\.artifact\.id\}/u);
  assert.match(canvas, /setTimeout\(\(\) => void persistCanvas\(\), 350\)/u);
  assert.match(canvas, /result\.status === "conflict"/u);
});

test("reference images are content-addressed in main and hydrated before canvas writes", () => {
  assert.match(canvas, /designerApi\.putReferenceAsset/u);
  assert.match(canvas, /designerApi\.readReferenceAsset/u);
  assert.match(canvas, /assetIdByNodeRef/u);
  assert.match(canvas, /if \(!savedProject \|\| !assetsHydrated\) return/u);
});

test("project inspector reads only project-owned generated revisions and exports through main", () => {
  assert.match(canvas, /designerApi\.readGeneratedSource/u);
  assert.match(canvas, /<DesignProjectInspector/u);
  assert.match(canvas, /designerApi[\s\S]*?\.exportProjectBundle/u);
  assert.match(canvas, /second\s+executable document/u);
});

test("persistent comments are initialized in main and remain project and immutable-revision scoped", () => {
  assert.match(main, /await designCommentStore\.initialize\(\)/u);
  assert.match(handlers, /designer:listComments/u);
  assert.match(handlers, /designer:createComment/u);
  assert.match(handlers, /requireOwnedCommentTarget/u);
  assert.match(handlers, /committedSourceFor/u);
  assert.match(handlers, /artifactId !== target\.source\.artifactId/u);
  assert.match(canvas, /<DesignCommentsPanel/u);
  assert.match(canvas, /expectedDatabaseRevision: currentView\.databaseRevision/u);
});

test("attached design systems are explicit, freshness proven, and preview exact model context", () => {
  assert.match(main, /await designSystemSnapshotStore\.initialize\(\)/u);
  assert.match(handlers, /designer:attachDesignSystem/u);
  assert.match(handlers, /designer:refreshDesignSystem/u);
  assert.match(handlers, /designer:detachDesignSystem/u);
  assert.match(handlers, /designer:designSystemModelContext/u);
  assert.match(canvas, /Exactly what Aiden sends with an accepted Design turn/u);
  assert.match(canvas, /does not run package code/u);
  assert.match(canvas, /designerApi\.designSystemModelContext/u);
});

test("recoverable handoffs stay project-visible with only semantically valid operations", () => {
  assert.match(handlers, /designer:projectHandoffRecoveries/u);
  assert.match(canvas, /designerApi\.projectHandoffRecoveries\(projectId\)/u);
  assert.match(canvas, /<DesignHandoffRecoveryPanel/u);
  assert.match(recovery, /record\.canResume/u);
  assert.match(recovery, /record\.canCancel/u);
  assert.match(recovery, /record\.linkage/u);
  assert.match(recovery, /\n\s+Resume\n/u);
  assert.match(recovery, /\n\s+Open <ArrowRight/u);
  assert.match(recovery, /<X aria-hidden="true" \/> Cancel/u);
  assert.match(recovery, /role="alert"/u);
  assert.match(recovery, /role="status"/u);
});

test("prototype direct-edit Undo is a native one-step control with compact and contrast-safe states", () => {
  assert.match(handlers, /designer:undoPrototypeDirectEdit/u);
  assert.match(directEditService, /direct-edit-revert/u);
  assert.match(directEditService, /artifactMediaIds: \[\.\.\.ids, mediaId\]/u);
  assert.match(directEditService, /activeMediaId: mediaId/u);
  assert.match(canvas, /designerApi\.undoPrototypeDirectEdit/u);
  assert.match(canvas, /onClick=\{\(\) => void undoPrototypeDirectEdit\(\)\}/u);
  assert.match(canvas, /Undo direct edit as a new exact-revert revision/u);
  assert.match(canvas, /role="status"/u);
  assert.match(styles, /\.design-direct-edit-undo/u);
  assert.match(styles, /:root\[data-reduce-motion="true"\][\s\S]*\.design-direct-edit-undo/u);
  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*\.design-direct-edit-undo/u);
  assert.match(styles, /@media \(forced-colors: active\)[\s\S]*\.design-handoff-recovery button:focus-visible/u);
});
