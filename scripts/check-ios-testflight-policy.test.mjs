import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

const internalWorkflowUrl = new URL(
  "../.github/workflows/aiden-on-the-go-internal-testflight.yml",
  import.meta.url,
);
const externalWorkflowUrl = new URL(
  "../.github/workflows/aiden-on-the-go-external-testflight.yml",
  import.meta.url,
);
const internalExportUrl = new URL("../ios/ci/TestFlightExportOptions.plist", import.meta.url);
const externalExportUrl = new URL(
  "../ios/ci/ExternalTestFlightExportOptions.plist",
  import.meta.url,
);

async function loadReleaseFiles() {
  const [internalWorkflow, externalWorkflow, internalExport, externalExport] = await Promise.all([
    readFile(internalWorkflowUrl, "utf8"),
    readFile(externalWorkflowUrl, "utf8"),
    readFile(internalExportUrl, "utf8"),
    readFile(externalExportUrl, "utf8"),
  ]);

  return { internalWorkflow, externalWorkflow, internalExport, externalExport };
}

function assertCommonUploadPolicy(workflow, environment) {
  assert.match(workflow, /^on:\n {2}workflow_dispatch:/mu);
  assert.doesNotMatch(workflow, /^ {2}(?:push|pull_request|schedule):/mu);
  assert.match(workflow, /permissions:\n {2}contents: read/u);
  assert.match(workflow, new RegExp(`environment: ${environment}`, "u"));
  assert.match(workflow, new RegExp(`group: ${environment}`, "u"));
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.match(workflow, /\$\{GITHUB_REF_NAME\}" != "main"/u);
  assert.match(workflow, /actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803/u);
  assert.doesNotMatch(workflow, /actions\/checkout@v\d+/u);
  assert.match(workflow, /PROJECT_PATH: ios\/AidenOnTheGo\.xcodeproj/u);
  assert.match(workflow, /SCHEME: AidenOnTheGo/u);
  assert.match(workflow, /TEAM_ID: 5WP229CBB8/u);
  assert.match(workflow, /BUNDLE_ID: sbtbiswas\.AidenOnTheGo/u);
  assert.match(workflow, /ruby ios\/ci\/select_testflight_build_number\.rb/u);
  assert.match(workflow, /-destination "generic\/platform=iOS"/u);
  assert.match(workflow, /-authenticationKeyPath/u);
  assert.match(workflow, /-authenticationKeyID/u);
  assert.match(workflow, /-authenticationKeyIssuerID/u);
  assert.match(workflow, /CURRENT_PROJECT_VERSION="\$\{BUILD_NUMBER\}"/u);
  assert.doesNotMatch(workflow, /simulator/iu);
  assert.doesNotMatch(workflow, /Hermes/u);
}

test("internal TestFlight workflow remains manually gated and internal-only", async () => {
  const { internalWorkflow, internalExport } = await loadReleaseFiles();

  assertCommonUploadPolicy(internalWorkflow, "aiden-on-the-go-internal-testflight");
  assert.match(internalWorkflow, /confirm_internal_only/u);
  assert.match(internalWorkflow, /CONFIRM_INTERNAL_ONLY\}" != "INTERNAL"/u);
  assert.match(internalWorkflow, /EXPORT_OPTIONS_PLIST: ios\/ci\/TestFlightExportOptions\.plist/u);
  assert.doesNotMatch(internalWorkflow, /ENFORCE_OPEN_TRAIN/u);
  assert.match(internalExport, /<key>testFlightInternalTestingOnly<\/key>\s*<true\/>/u);
});

test("external TestFlight workflow is explicit, train-safe, and upload-only", async () => {
  const { externalWorkflow, externalExport } = await loadReleaseFiles();

  assertCommonUploadPolicy(externalWorkflow, "aiden-on-the-go-external-testflight");
  assert.match(externalWorkflow, /confirm_external_review/u);
  assert.match(externalWorkflow, /CONFIRM_EXTERNAL_REVIEW\}" != "EXTERNAL_REVIEW"/u);
  assert.match(
    externalWorkflow,
    /EXPORT_OPTIONS_PLIST: ios\/ci\/ExternalTestFlightExportOptions\.plist/u,
  );
  assert.match(externalWorkflow, /ENFORCE_OPEN_TRAIN: "1"/u);
  assert.match(
    externalWorkflow,
    /uploads only; App Store Connect external group assignment and Beta App Review submission remain manual/u,
  );
  assert.doesNotMatch(externalExport, /testFlightInternalTestingOnly/u);
});

test("both export policies use automatic App Store Connect upload signing", async () => {
  const { internalExport, externalExport } = await loadReleaseFiles();

  for (const exportPolicy of [internalExport, externalExport]) {
    assert.match(exportPolicy, /<key>destination<\/key>\s*<string>upload<\/string>/u);
    assert.match(exportPolicy, /<key>method<\/key>\s*<string>app-store-connect<\/string>/u);
    assert.match(exportPolicy, /<key>signingStyle<\/key>\s*<string>automatic<\/string>/u);
    assert.match(exportPolicy, /<key>teamID<\/key>\s*<string>5WP229CBB8<\/string>/u);
    assert.match(exportPolicy, /<key>manageAppVersionAndBuildNumber<\/key>\s*<false\/>/u);
  }
});
