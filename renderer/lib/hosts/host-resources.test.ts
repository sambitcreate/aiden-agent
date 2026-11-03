import assert from "node:assert/strict";
import test from "node:test";
import { MAX_ATTACHMENT_INLINE_BYTES, MAX_INLINE_IMAGE_BYTES } from "../../shared/attachment-contract";
import type { Attachment } from "../types";
import {
  HostResourceShapeError,
  defaultHostModel,
  findHostModel,
  findOfferedHostModel,
  mapHostBrowserPage,
  mapHostCreatedChat,
  mapHostModelCatalog,
} from "./host-resources";
import {
  prepareRemoteAttachmentUploads,
  RemoteAttachmentError,
  remoteAttachmentUploads,
  type RemoteImageDecoder,
} from "./remote-attachments";

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

test("a host's model catalog offers only models it allows for new chats, and keeps hidden ones for chats already on them", () => {
  const mapped = mapHostModelCatalog(catalog);
  assert.equal(findOfferedHostModel(mapped, { providerId: "acme", modelId: "fast" })?.supportsImages, true);
  assert.equal(findOfferedHostModel(mapped, { providerId: "acme", modelId: "old" }), undefined, "never a new choice");
  assert.equal(findOfferedHostModel(mapped, { providerId: "empty", modelId: "x" }), undefined);
  // An existing chat on a hidden model still names it and runs on it.
  assert.equal(findHostModel(mapped, { providerId: "acme", modelId: "old" })?.label, "Old");
});

test("a host model carries the effort levels the host runs it at", () => {
  const mapped = mapHostModelCatalog({
    providers: [
      {
        id: "acme",
        label: "Acme",
        models: [
          { id: "deep", label: "Deep", supportsImages: false, thinkingLevels: ["low", "high", "bogus"], defaultThinkingLevel: "high", thinkingCanDisable: false },
          { id: "plain", label: "Plain", supportsImages: false, defaultThinkingLevel: "high" },
        ],
      },
    ],
    defaults: {},
  });
  const deep = findHostModel(mapped, { providerId: "acme", modelId: "deep" });
  assert.deepEqual(deep?.thinkingLevels, ["low", "high"], "a level this Mac doesn't know is dropped");
  assert.equal(deep?.defaultThinkingLevel, "high");
  assert.equal(deep?.thinkingCanDisable, false);
  const plain = findHostModel(mapped, { providerId: "acme", modelId: "plain" });
  assert.deepEqual(plain?.thinkingLevels, []);
  assert.equal(plain?.defaultThinkingLevel, undefined, "a default the model doesn't list is ignored");
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

/**
 * A decoder whose encoded size is `bytesPerPixel` × the drawn area, so the
 * shrinking steps are visible; `null` stands for a picture it cannot read.
 */
function fakeDecoder(
  size: { width: number; height: number } | null,
  bytesPerPixel: Partial<Record<"image/png" | "image/jpeg", number>> = { "image/png": 4, "image/jpeg": 1 },
) {
  let decoded = 0;
  const decode: RemoteImageDecoder = async () => {
    decoded += 1;
    return (
      size && {
        ...size,
        async encode(width, height, mimeType) {
          return new Uint8Array(Math.ceil(width * height * (bytesPerPixel[mimeType] ?? 1)));
        },
        close() {},
      }
    );
  };
  return { decode, decodes: () => decoded };
}

const pixels = (kilobytes: number) => btoa("x".repeat(kilobytes * 1024));

test("images another Mac would refuse are redrawn as PNG or JPEG before they are sent", async () => {
  const { decode } = fakeDecoder({ width: 40, height: 30 });
  const [gif, bitmap, png] = await prepareRemoteAttachmentUploads(
    [
      attachment({ kind: "image", mimeType: "image/gif", name: "wave.gif", data: pixels(1), size: 1024 }),
      attachment({ kind: "image", mimeType: "image/bmp", name: "scan.bmp", data: pixels(1), size: 1024 }),
      attachment({ kind: "image", mimeType: "image/png", name: "shot.png", data: "iVBORw0KGgo=", size: 8 }),
    ],
    decode,
  );
  // A picture that may be transparent becomes a PNG; a PNG or JPEG that fits goes as it is.
  assert.deepEqual(
    [gif, bitmap].map((upload) => upload?.kind === "image" && [upload.name, upload.mimeType, atob(upload.data).length]),
    [
      ["wave.png", "image/png", 40 * 30 * 4],
      ["scan.png", "image/png", 40 * 30 * 4],
    ],
  );
  assert.deepEqual(png, { name: "shot.png", mimeType: "image/png", kind: "image", data: "iVBORw0KGgo=" });
});

test("a picture too large for another Mac is sent at the largest size that fits, as a JPEG when no PNG of that size fits", async () => {
  // As PNG, 3000×2000 is 24 MB and 2250×1500 is 13.5 MB; as JPEG, 3000×2000 is 12 MB and 2250×1500 is 6.75 MB.
  const { decode } = fakeDecoder({ width: 3000, height: 2000 }, { "image/png": 4, "image/jpeg": 2 });
  const [upload] = await prepareRemoteAttachmentUploads(
    [attachment({ kind: "image", mimeType: "image/webp", name: "board.webp", data: pixels(4), size: 4096 })],
    decode,
  );
  assert.ok(upload?.kind === "image");
  assert.equal(upload.mimeType, "image/jpeg");
  assert.equal(upload.name, "board.jpg");
  assert.equal(atob(upload.data).length, 2250 * 1500 * 2);
});

test("pictures that grow when redrawn still go together within the host's limit for one message", async () => {
  // Each small WebP redraws as a 6 MiB PNG; three of those would be 18 MiB, over the 16 MiB a message may carry.
  const { decode } = fakeDecoder({ width: 1024, height: 1536 }, { "image/png": 4, "image/jpeg": 1 });
  const uploads = await prepareRemoteAttachmentUploads(
    ["a", "b", "c"].map((name) =>
      attachment({ kind: "image", mimeType: "image/webp", name: `${name}.webp`, data: pixels(1), size: 1024 }),
    ),
    decode,
  );
  const sizes = uploads.map((upload) => (upload.kind === "image" ? atob(upload.data).length : 0));
  assert.ok(sizes.reduce((total, size) => total + size, 0) <= MAX_ATTACHMENT_INLINE_BYTES);
  assert.deepEqual(
    uploads.map((upload) => upload.kind === "image" && upload.mimeType),
    ["image/png", "image/png", "image/jpeg"],
    "the last picture is drawn as a JPEG so all three fit",
  );
});

test("a picture this Mac cannot decode is explained instead of sent", async () => {
  await assert.rejects(
    prepareRemoteAttachmentUploads(
      [attachment({ kind: "image", mimeType: "image/webp", name: "broken.webp", data: pixels(1), size: 1024 })],
      fakeDecoder(null).decode,
    ),
    (error) =>
      error instanceof RemoteAttachmentError &&
      error.message === "broken.webp can't be sent to another Mac. Save it as a PNG or JPEG and attach it again.",
  );
});

test("a HEIC photo is explained without trying to redraw it", async () => {
  const decoder = fakeDecoder({ width: 40, height: 30 });
  await assert.rejects(
    prepareRemoteAttachmentUploads(
      [attachment({ kind: "image", mimeType: "image/heic", name: "IMG_0043.HEIC", data: pixels(1), size: 1024 })],
      decoder.decode,
    ),
    (error) => error instanceof RemoteAttachmentError && /IMG_0043\.HEIC is a HEIC photo/.test(error.message),
  );
  assert.equal(decoder.decodes(), 0);
});
