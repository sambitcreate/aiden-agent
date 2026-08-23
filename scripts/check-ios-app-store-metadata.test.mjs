import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

const fileUrls = {
  metadata: new URL("../ios/APP_STORE_METADATA.md", import.meta.url),
  info: new URL("../ios/AidenOnTheGo/Resources/Info.plist", import.meta.url),
  privacy: new URL("../ios/AidenOnTheGo/Resources/PrivacyInfo.xcprivacy", import.meta.url),
  appConfig: new URL("../ios/AidenOnTheGo/Config/AppConfig.swift", import.meta.url),
  packages: new URL(
    "../ios/AidenOnTheGo.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved",
    import.meta.url,
  ),
  ascRunbook: new URL("../ios/ASC_CLI.md", import.meta.url),
  appInfoMetadata: new URL(
    "../ios/app-store/metadata/app-info/en-US.json",
    import.meta.url,
  ),
  versionMetadata: new URL(
    "../ios/app-store/metadata/version/0.1.0/en-US.json",
    import.meta.url,
  ),
  mobilePrivacySupport: new URL(
    "../ios/app-store/MOBILE_PRIVACY_SUPPORT_COPY.md",
    import.meta.url,
  ),
  gitignore: new URL("../.gitignore", import.meta.url),
};

async function loadFiles() {
  const entries = await Promise.all(
    Object.entries(fileUrls).map(async ([name, url]) => [name, await readFile(url, "utf8")]),
  );
  return Object.fromEntries(entries);
}

function backtickValue(source, label) {
  const marker = "\u0060";
  const match = source.match(new RegExp(`^- ${label}: ${marker}([^${marker}]+)${marker}$`, "mu"));
  assert.ok(match, `missing metadata field: ${label}`);
  return match[1];
}

test("public App Store identity stays aligned with shipping app links", async () => {
  const { metadata, appConfig } = await loadFiles();

  assert.equal(backtickValue(metadata, "Bundle ID"), "sbtbiswas.AidenOnTheGo");
  assert.equal(backtickValue(metadata, "App Store SKU"), "aiden-on-the-go-ios");
  assert.equal(backtickValue(metadata, "Marketing URL"), "https://chatwithaiden.com/");
  assert.equal(backtickValue(metadata, "Support URL"), "https://chatwithaiden.com/");
  assert.equal(
    backtickValue(metadata, "Privacy-policy URL"),
    "https://chatwithaiden.com/privacy",
  );
  assert.match(appConfig, /privacyPolicyURL = URL\(staticString: "https:\/\/chatwithaiden\.com\/privacy"\)/u);
  assert.match(appConfig, /supportURL = URL\(staticString: "https:\/\/chatwithaiden\.com\/"\)/u);
});

test("release metadata names the current processed TestFlight candidate", async () => {
  const { metadata } = await loadFiles();

  assert.match(metadata, /build `17` is the current processed internal candidate/u);
  assert.doesNotMatch(metadata, /build `6` is the current internal candidate/u);
});

test("ASC owner operations are telemetry-off, strict, and credential-safe", async () => {
  const { ascRunbook, gitignore } = await loadFiles();

  assert.match(ascRunbook, /ASC_TELEMETRY_DISABLED=1/u);
  assert.match(ascRunbook, /--strict-auth/u);
  assert.match(ascRunbook, /read-only/u);
  assert.match(ascRunbook, /Do not create a placeholder automation for build `2`/u);
  assert.match(ascRunbook, /721aeb9d-2b33-4729-8d10-5bc1783abbef/u);
  assert.match(ascRunbook, /IN_BETA_TESTING/u);
  assert.match(ascRunbook, /https:\/\/testflight\.apple\.com\/join\/s3T4T8y3/u);
  assert.match(ascRunbook, /Zero accessible app records must not be treated as permission to auto-create one/u);
  assert.match(ascRunbook, /resolve the existing record read-only/u);
  assert.match(ascRunbook, /asc web privacy pull/u);
  assert.match(ascRunbook, /asc screenshots validate/u);
  assert.match(ascRunbook, /npm run ios:asc-monitor/u);
  assert.match(ascRunbook, /builds info --build-id/u);
  assert.match(ascRunbook, /never tester identity, feedback text, screenshot URLs, or crash content/u);
  assert.doesNotMatch(ascRunbook, /AuthKey_[A-Z0-9]+\.p8/u);
  assert.match(gitignore, /^\.asc\/config\.json$/mu);
  assert.match(gitignore, /^\.asc\/sessions\/$/mu);
});

test("store copy respects App Store field limits and resolved categories", async () => {
  const { metadata, appInfoMetadata, versionMetadata } = await loadFiles();
  const name = backtickValue(metadata, "Name");
  const subtitle = backtickValue(metadata, "Subtitle");
  const keywords = backtickValue(metadata, "Keywords draft");
  const appInfo = JSON.parse(appInfoMetadata);
  const version = JSON.parse(versionMetadata);

  assert.ok(name.length >= 2 && name.length <= 30);
  assert.ok(subtitle.length <= 30);
  assert.ok(Buffer.byteLength(keywords, "utf8") <= 100);
  assert.match(metadata, /^- Primary category: Developer Tools$/mu);
  assert.match(metadata, /^- Secondary category: Productivity$/mu);
  assert.deepEqual(appInfo, {
    name,
    subtitle,
    privacyPolicyUrl: backtickValue(metadata, "Privacy-policy URL"),
  });
  assert.equal(version.keywords, keywords);
  assert.equal(version.marketingUrl, backtickValue(metadata, "Marketing URL"));
  assert.equal(version.supportUrl, backtickValue(metadata, "Support URL"));
  assert.ok(version.description.length > 0 && version.description.length <= 4_000);
  assert.doesNotMatch(version.description, /<[^>]+>|\[[^\]]+\]\([^)]+\)/u);
  assert.deepEqual(Object.keys(version).sort(), [
    "description",
    "keywords",
    "marketingUrl",
    "supportUrl",
  ]);
});

test("age and privacy drafts stay conservative and match the bundle manifest", async () => {
  const { metadata, info, privacy, packages, mobilePrivacySupport } = await loadFiles();
  const packagePins = JSON.parse(packages).pins.map((pin) => pin.identity.toLowerCase());
  const telemetryPackages = [
    "amplitude",
    "datadog",
    "firebase",
    "mixpanel",
    "posthog",
    "segment",
    "sentry",
  ];

  assert.match(metadata, /\| Override \| 13\+ \|/u);
  assert.match(metadata, /\*\*No, we do not collect data from this app\.\*\*/u);
  assert.match(mobilePrivacySupport, /ready for owner\/legal review/u);
  assert.match(mobilePrivacySupport, /iPhone or iPad Keychain/u);
  assert.match(mobilePrivacySupport, /local network or a Tailscale connection/u);
  assert.match(mobilePrivacySupport, /does not enable Tailscale Funnel/u);
  assert.match(mobilePrivacySupport, /requires on-device recognition/u);
  assert.match(mobilePrivacySupport, /App Intents use a limited App Group cache/u);
  assert.match(mobilePrivacySupport, /hide assistant response excerpts by default/u);
  assert.match(mobilePrivacySupport, /hey@sambitbiswas\.com/u);
  assert.match(mobilePrivacySupport, /do not send provider API keys, pairing credentials/u);
  assert.match(info, /<key>ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/u);
  assert.match(info, /<key>NSLocalNetworkUsageDescription<\/key>/u);
  assert.match(info, /<key>NSCameraUsageDescription<\/key>/u);
  assert.match(info, /<key>NSMicrophoneUsageDescription<\/key>/u);
  assert.match(info, /<key>NSSpeechRecognitionUsageDescription<\/key>/u);
  assert.match(privacy, /<key>NSPrivacyTracking<\/key>\s*<false\/>/u);
  assert.match(privacy, /<key>NSPrivacyCollectedDataTypes<\/key>\s*<array\/>/u);
  assert.match(privacy, /<string>CA92\.1<\/string>/u);
  assert.deepEqual(
    packagePins.filter((identity) => telemetryPackages.includes(identity)),
    [],
    "update App Privacy metadata before adding telemetry or analytics packages",
  );
});
