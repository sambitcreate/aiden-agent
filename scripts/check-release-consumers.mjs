/* global AbortController, clearTimeout, console, fetch, process, setTimeout */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const modulePath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(modulePath), "..");

export const WEBSITE_DMG_NAME = "Aiden-Agent-Beta-arm64.dmg";
export const WEBSITE_DMG_URL = `https://github.com/sambitcreate/aiden-agent/releases/latest/download/${WEBSITE_DMG_NAME}`;
export const LEGACY_WEBSITE_DMG_URL = "https://download.chatwithaiden.com/Aiden-Agent-Beta.dmg";

export const RELEASE_CONSUMER_URLS = Object.freeze({
  homebrewCask:
    "https://raw.githubusercontent.com/sambitcreate/homebrew-tap/main/Casks/aiden-agent.rb",
  homebrewUpdater:
    "https://raw.githubusercontent.com/sambitcreate/homebrew-tap/main/scripts/update-aiden-cask.sh",
  website: "https://chatwithaiden.com/",
  websiteDmg: WEBSITE_DMG_URL,
  legacyWebsiteDmg: LEGACY_WEBSITE_DMG_URL,
});

const EXPECTED_VERSIONED_DMG = "Aiden-Agent-Beta-${version}-${arch}.${ext}";
const EXPECTED_CASK_ASSET = "Aiden-Agent-Beta-#{version}-arm64.dmg";
const EXPECTED_UPDATER_ASSET = 'asset_name="Aiden-Agent-Beta-${version}-arm64.dmg"';

function requireText(source, expected, message) {
  if (!source.includes(expected)) throw new Error(message);
}

export function verifyLocalReleaseContract(packageJson) {
  if (packageJson?.build?.dmg?.artifactName !== EXPECTED_VERSIONED_DMG) {
    throw new Error(
      `Aiden's versioned DMG contract changed. Update and deploy every release consumer before changing ${EXPECTED_VERSIONED_DMG}.`,
    );
  }
}

export function verifyHomebrewReleaseContract({ cask, updater }) {
  requireText(
    cask,
    EXPECTED_CASK_ASSET,
    `The Homebrew cask does not reference ${EXPECTED_CASK_ASSET}.`,
  );
  requireText(
    updater,
    EXPECTED_UPDATER_ASSET,
    `The Homebrew updater does not select ${EXPECTED_UPDATER_ASSET}.`,
  );
}

export function verifyWebsiteReleaseContract(html) {
  requireText(
    html,
    `href="${WEBSITE_DMG_URL}"`,
    `The production website does not link to the stable latest-release DMG URL ${WEBSITE_DMG_URL}.`,
  );
}

export function verifyLegacyWebsiteDmgContract(response) {
  if (response.status !== 307 || response.headers.get("location") !== WEBSITE_DMG_URL) {
    throw new Error(
      `The legacy website DMG URL must redirect with HTTP 307 to ${WEBSITE_DMG_URL}.`,
    );
  }
  const cacheDirectives = (response.headers.get("cache-control") ?? "")
    .split(",")
    .map((directive) => directive.trim().toLowerCase());
  if (!cacheDirectives.includes("no-store")) {
    throw new Error("The legacy website DMG redirect must not be cached.");
  }
}

async function request(
  fetchImpl,
  url,
  { method = "GET", redirect = "follow", expectedStatus } = {},
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetchImpl(url, {
      method,
      redirect,
      signal: controller.signal,
      headers: { "user-agent": "aiden-release-consumer-check" },
    });
    if (expectedStatus === undefined ? !response.ok : response.status !== expectedStatus) {
      throw new Error(`${url} returned HTTP ${response.status}.`);
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

async function responseText(fetchImpl, url) {
  const response = await request(fetchImpl, url);
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > 1_000_000) throw new Error(`${url} exceeded the consumer-check size limit.`);
  return response.text();
}

export async function checkReleaseConsumers({ fetchImpl = fetch, log = console.log } = {}) {
  const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  verifyLocalReleaseContract(packageJson);

  const [cask, updater, website, websiteDmg, legacyWebsiteDmg] = await Promise.all([
    responseText(fetchImpl, RELEASE_CONSUMER_URLS.homebrewCask),
    responseText(fetchImpl, RELEASE_CONSUMER_URLS.homebrewUpdater),
    responseText(fetchImpl, RELEASE_CONSUMER_URLS.website),
    request(fetchImpl, RELEASE_CONSUMER_URLS.websiteDmg, { method: "HEAD" }),
    request(fetchImpl, RELEASE_CONSUMER_URLS.legacyWebsiteDmg, {
      method: "HEAD",
      redirect: "manual",
      expectedStatus: 307,
    }),
  ]);

  verifyHomebrewReleaseContract({ cask, updater });
  verifyWebsiteReleaseContract(website);
  verifyLegacyWebsiteDmgContract(legacyWebsiteDmg);

  const downloadSize = Number(websiteDmg.headers.get("content-length") ?? 0);
  if (!Number.isSafeInteger(downloadSize) || downloadSize <= 0) {
    throw new Error("The stable website DMG URL did not report a non-empty release asset.");
  }
  const contentType = websiteDmg.headers.get("content-type") ?? "";
  if (!/(?:x-apple-diskimage|octet-stream)/iu.test(contentType)) {
    throw new Error(
      `The stable website DMG URL returned an unexpected content type: ${contentType}`,
    );
  }

  log(`Release consumers are aligned; the website DMG is ${downloadSize} bytes.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  checkReleaseConsumers().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
