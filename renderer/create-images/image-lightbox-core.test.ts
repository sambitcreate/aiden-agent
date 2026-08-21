import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  clampCreateImagesLightboxOffset,
  clampCreateImagesLightboxZoom,
  createImagesLightboxFitZoom,
  createImagesLightboxPan,
  createImagesLightboxZoomAtPoint,
  CREATE_IMAGES_LIGHTBOX_MAX_ZOOM,
  CREATE_IMAGES_LIGHTBOX_MIN_ZOOM,
} from "./image-lightbox-core";

test("image lightbox fits large media without upscaling smaller media", () => {
  assert.equal(
    createImagesLightboxFitZoom({ width: 4_000, height: 2_000 }, { width: 1_000, height: 600 }, 20),
    0.24,
  );
  assert.equal(
    createImagesLightboxFitZoom({ width: 320, height: 240 }, { width: 1_000, height: 600 }),
    1,
  );
  assert.equal(clampCreateImagesLightboxZoom(0), CREATE_IMAGES_LIGHTBOX_MIN_ZOOM);
  assert.equal(clampCreateImagesLightboxZoom(100), CREATE_IMAGES_LIGHTBOX_MAX_ZOOM);
});

test("image lightbox zoom preserves the pointed pixel and keeps panning bounded", () => {
  const image = { width: 2_000, height: 1_200 };
  const viewport = { width: 1_000, height: 600 };
  const zoomed = createImagesLightboxZoomAtPoint(
    { zoom: 0.5, offset: { x: 0, y: 0 } },
    1,
    { x: 200, y: 100 },
    image,
    viewport,
  );
  assert.deepEqual(zoomed, { zoom: 1, offset: { x: -200, y: -100 } });

  assert.deepEqual(createImagesLightboxPan(zoomed, { x: 9_000, y: -9_000 }, image, viewport), {
    zoom: 1,
    offset: { x: 500, y: -300 },
  });
  assert.deepEqual(
    clampCreateImagesLightboxOffset({ x: 50, y: -50 }, { width: 400, height: 300 }, viewport, 1),
    { x: 0, y: 0 },
  );
});

test("image inspector is a secure, keyboard-accessible Radix surface", () => {
  const component = readFileSync(new URL("./image-lightbox.tsx", import.meta.url), "utf8");
  const node = readFileSync(new URL("./workflow-node.tsx", import.meta.url), "utf8");
  const canvas = readFileSync(new URL("./workflow-canvas.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("./create-images.css", import.meta.url), "utf8");

  assert.match(component, /<DialogPrimitive\.Root open=\{open\}/u);
  assert.match(component, /data-slot="dialog-content"/u);
  assert.match(component, /onCloseAutoFocus/u);
  assert.match(component, /event\.key === "0"/u);
  assert.match(component, /event\.key\.toLowerCase\(\) === "f"/u);
  assert.match(component, /onWheel=/u);
  assert.match(component, /onPointerMove=/u);
  assert.match(component, /src=\{createImagesAssetGrantUrl\(asset\.token, "original"\)\}/u);
  assert.match(component, /const \[stageElement, setStageElement\]/u);
  assert.match(component, /\[open, stageElement\]/u);
  assert.doesNotMatch(component, /file:\/\/|absolutePath|data:image/u);
  assert.match(node, /aria-label=\{`Inspect \$\{label\}`\}/u);
  assert.match(node, /actions\.inspectAsset\(assetId, "run"/u);
  assert.match(node, /Inspect image for Image Input/u);
  assert.match(
    canvas,
    /inspectedAsset\.source === "recent"[\s\S]{0,120}onRecentOutputPreviewMount[\s\S]{0,120}onRunAssetPreviewMount[\s\S]{0,80}onAssetPreviewMount/u,
  );
  assert.match(canvas, /<CreateImagesImageLightbox/u);
  assert.match(styles, /prefers-reduced-motion: reduce/u);
  assert.match(styles, /forced-colors: active/u);
});
