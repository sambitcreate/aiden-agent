import assert from "node:assert/strict";
import test from "node:test";
import { MAX_INLINE_IMAGE_BYTES } from "../../shared/attachment-contract";
import type { Attachment } from "../types";
import {
  HostResourceShapeError,
  defaultHostModel,
  findHostModel,
  mapHostBrowserPage,
  mapHostCreatedChat,
  mapHostModelCatalog,
} from "./host-resources";
import { RemoteAttachmentError, remoteAttachmentUploads } from "./remote-attachments";

const catalog = {
  providers: [
    {
      id: "acme",
      label: "Acme",
      models: [
        { id: "old", label: "Old", supportsImages: false, hidden: true },
        { id: "fast", label: "Fast", supportsImages: true },
      ],
    },
    { id: "empty", label: "Only hidden", models: [{ id: "x", label: "X", supportsImages: false, hidden: true }] },
    { id: "zen", label: "Zen", models: [{ id: "calm", label: "Calm", supportsImages: false }] },
  ],
  defaults: { providerId: "zen", modelId: "calm" },
};

test("a host's model catalog offers only models it allows for new chats", () => {
  const mapped = mapHostModelCatalog(catalog);
  assert.deepEqual(
    mapped.providers.map((provider) => [provider.id, provider.models.map((model) => model.id)]),
    [
      ["acme", ["fast"]],
      ["zen", ["calm"]],
    ],
  );
  assert.equal(findHostModel(mapped, { providerId: "acme", modelId: "fast" })?.supportsImages, true);
  assert.equal(findHostModel(mapped, { providerId: "acme", modelId: "old" }), undefined);
});

test("the host default is preselected only while the host still offers it", () => {
  assert.deepEqual(defaultHostModel(mapHostModelCatalog(catalog)), { providerId: "zen", modelId: "calm" });
  const hiddenDefault = mapHostModelCatalog({ ...catalog, defaults: { providerId: "acme", modelId: "old" } });
  assert.deepEqual(defaultHostModel(hiddenDefault), { providerId: "acme", modelId: "fast" });
  assert.equal(defaultHostModel(mapHostModelCatalog({ providers: [], defaults: {} })), undefined);
});

test("browser pages keep the host's opaque locations and refuse an entry without one", () => {
  const page = mapHostBrowserPage({
    rootId: "home",
    label: "Projects",
    breadcrumbs: [{ label: "Home", location: "loc_home" }],
    entries: [{ id: "e1", name: "site", location: "loc_site" }],
    nextCursor: "cur_2",
  });
  assert.equal(page.entries[0]?.location, "loc_site");
  assert.equal(page.nextCursor, "cur_2");
  assert.throws(
    () => mapHostBrowserPage({ rootId: "home", breadcrumbs: [], entries: [{ id: "e1", name: "site" }] }),
    HostResourceShapeError,
  );
});

test("a created chat must name its project on the host", () => {
  assert.deepEqual(mapHostCreatedChat({ id: "c1", workspaceId: "w1", title: "New" }), { id: "c1", workspaceId: "w1" });
  assert.throws(() => mapHostCreatedChat({ id: "c1" }), HostResourceShapeError);
});

function attachment(patch: Partial<Attachment>): Attachment {
  return { id: "a", name: "notes.md", mimeType: "text/markdown", kind: "text", size: 7, text: "# Notes", ...patch };
}

test("attachments become uploads the host accepts", () => {
  const uploads = remoteAttachmentUploads([
    attachment({ name: "../secret/plan.md" }),
    attachment({ name: "build.sh", mimeType: "application/x-sh", text: "echo hi" }),
    attachment({ name: "shot.PNG", mimeType: "image/PNG", kind: "image", data: "iVBORw0KGgo=", size: 9 }),
  ]);
  assert.deepEqual(uploads, [
    { name: ".._secret_plan.md", mimeType: "text/markdown", kind: "text", text: "# Notes" },
    { name: "build.sh", mimeType: "text/plain", kind: "text", text: "echo hi" },
    { name: "shot.PNG", mimeType: "image/png", kind: "image", data: "iVBORw0KGgo=" },
  ]);
  const long = remoteAttachmentUploads([attachment({ text: "x".repeat(100_005) })]);
  assert.equal(long[0]?.kind === "text" ? long[0].text.length : 0, 100_000);
});

test("attachments the host would refuse are explained before anything is uploaded", () => {
  assert.throws(
    () => remoteAttachmentUploads([attachment({ kind: "image", mimeType: "image/gif", data: "R0lG", name: "a.gif" })]),
    RemoteAttachmentError,
  );
  assert.throws(
    () =>
      remoteAttachmentUploads([
        attachment({ kind: "image", mimeType: "image/png", data: "x", size: MAX_INLINE_IMAGE_BYTES + 1 }),
      ]),
    RemoteAttachmentError,
  );
  assert.throws(() => remoteAttachmentUploads(Array.from({ length: 11 }, () => attachment({}))), RemoteAttachmentError);
});
