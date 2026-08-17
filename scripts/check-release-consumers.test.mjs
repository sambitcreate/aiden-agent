/* global Response */

import assert from "node:assert/strict";
import test from "node:test";
import {
  checkReleaseConsumers,
  RELEASE_CONSUMER_URLS,
  verifyHomebrewReleaseContract,
  verifyLegacyWebsiteDmgContract,
  verifyLocalReleaseContract,
  verifyWebsiteReleaseContract,
  WEBSITE_DMG_URL,
} from "./check-release-consumers.mjs";

const packageJson = {
  build: { dmg: { artifactName: "Aiden-Agent-Beta-${version}-${arch}.${ext}" } },
};
const cask = 'url "https://example.test/v#{version}/Aiden-Agent-Beta-#{version}-arm64.dmg"';
const updater = 'asset_name="Aiden-Agent-Beta-${version}-arm64.dmg"';
const website = `<a href="${WEBSITE_DMG_URL}">Download</a>`;

test("release consumer contract accepts the coordinated stable and versioned DMG names", () => {
  assert.doesNotThrow(() => verifyLocalReleaseContract(packageJson));
  assert.doesNotThrow(() => verifyHomebrewReleaseContract({ cask, updater }));
  assert.doesNotThrow(() => verifyWebsiteReleaseContract(website));
  assert.doesNotThrow(() =>
    verifyLegacyWebsiteDmgContract(
      new Response(null, {
        status: 307,
        headers: { "cache-control": "no-store", location: WEBSITE_DMG_URL },
      }),
    ),
  );
});

test("release consumer contract fails closed when any consumer drifts", () => {
  assert.throws(
    () => verifyLocalReleaseContract({ build: { dmg: { artifactName: "Aiden.${version}.dmg" } } }),
    /versioned DMG contract changed/u,
  );
  assert.throws(
    () => verifyHomebrewReleaseContract({ cask: "old cask", updater }),
    /Homebrew cask/u,
  );
  assert.throws(
    () => verifyHomebrewReleaseContract({ cask, updater: "old updater" }),
    /Homebrew updater/u,
  );
  assert.throws(() => verifyWebsiteReleaseContract("old website"), /production website/u);
  assert.throws(
    () =>
      verifyLegacyWebsiteDmgContract(
        new Response(null, { status: 307, headers: { location: "https://old.example/dmg" } }),
      ),
    /legacy website DMG URL/u,
  );
  assert.throws(
    () =>
      verifyLegacyWebsiteDmgContract(
        new Response(null, { status: 307, headers: { location: WEBSITE_DMG_URL } }),
      ),
    /must not be cached/u,
  );
});

test("live consumer check validates remote text and the stable DMG response", async () => {
  const responses = new Map([
    [RELEASE_CONSUMER_URLS.homebrewCask, new Response(cask)],
    [RELEASE_CONSUMER_URLS.homebrewUpdater, new Response(updater)],
    [RELEASE_CONSUMER_URLS.website, new Response(website)],
    [
      RELEASE_CONSUMER_URLS.websiteDmg,
      new Response(null, {
        headers: {
          "content-length": "42",
          "content-type": "application/x-apple-diskimage",
        },
      }),
    ],
    [
      RELEASE_CONSUMER_URLS.legacyWebsiteDmg,
      new Response(null, {
        status: 307,
        headers: { "cache-control": "no-store", location: WEBSITE_DMG_URL },
      }),
    ],
  ]);
  const logs = [];

  await checkReleaseConsumers({
    fetchImpl: async (url) => responses.get(url) ?? new Response(null, { status: 404 }),
    log: (message) => logs.push(message),
  });

  assert.deepEqual(logs, ["Release consumers are aligned; the website DMG is 42 bytes."]);
});
