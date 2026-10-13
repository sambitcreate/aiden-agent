import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DOMParser } from "@xmldom/xmldom";
import { ImageModelLogo, ImageProviderLogo } from "./image-model-logo";

function root(markup: string) {
  return new DOMParser().parseFromString(markup, "text/xml").documentElement!;
}

/** The mask URL a rendered mark paints, resolved back to a file on disk. */
function maskFile(element: ReturnType<typeof root>): string {
  const match = /mask-image:\s*url\("([^"]+)"\)/u.exec(element.getAttribute("style") ?? "");
  assert.ok(match, "the mark is painted through a CSS mask");
  return fileURLToPath(match[1]!);
}

test("a known maker renders its mono mask mark, hidden from assistive tech", () => {
  const mark = root(
    renderToStaticMarkup(
      <ImageModelLogo providerId="replicate" modelId="black-forest-labs/flux-2-pro" label="FLUX.2 Pro" />,
    ),
  );
  assert.equal(mark.getAttribute("data-image-logo"), "black-forest-labs");
  assert.equal(mark.getAttribute("aria-hidden"), "true");
  assert.match(mark.getAttribute("style") ?? "", /background-color:\s*currentColor/u);
  assert.ok(existsSync(maskFile(mark)));
  assert.equal(mark.textContent, "");
});

test("an explicit maker wins over inference and can reuse a chat-provider mark", () => {
  const mark = root(
    renderToStaticMarkup(
      <ImageModelLogo maker="openai" providerId="fal" modelId="fal-ai/flux/dev" label="Odd entry" />,
    ),
  );
  assert.equal(mark.getAttribute("data-image-logo"), "openai");
  assert.ok(existsSync(maskFile(mark)));
});

test("an unknown maker falls back to the model name's initial", () => {
  const fallback = root(
    renderToStaticMarkup(
      <ImageModelLogo providerId="replicate" modelId="someone/hidream-i1" label="hidream i1" />,
    ),
  );
  assert.equal(fallback.hasAttribute("data-image-logo"), false);
  assert.equal(fallback.getAttribute("data-image-logo-fallback"), "someone/hidream-i1");
  assert.equal(fallback.textContent, "H");

  const unmapped = root(
    renderToStaticMarkup(
      <ImageModelLogo maker="not-a-maker" providerId="fal" modelId="x/y" label="Yonder" />,
    ),
  );
  assert.equal(unmapped.textContent, "Y");
});

test("every image provider resolves to a bundled mark", () => {
  for (const providerId of ["openrouter", "replicate", "fal"] as const) {
    const mark = root(renderToStaticMarkup(<ImageProviderLogo providerId={providerId} />));
    assert.equal(mark.getAttribute("data-image-logo"), providerId);
    assert.ok(existsSync(maskFile(mark)), providerId);
  }
});
