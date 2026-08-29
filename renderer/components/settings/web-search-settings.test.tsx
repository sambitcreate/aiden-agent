import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./web-search-settings.tsx", import.meta.url), "utf8");

function between(start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing ${start}`);
  assert.notEqual(endIndex, -1, `Missing ${end}`);
  return source.slice(startIndex, endIndex);
}

test("Web Search settings use the redacted generic provider projection", () => {
  assert.match(source, /useWebSearch\(\)/u);
  assert.match(source, /webSearchApi\.(get|setEnabled|setSelection|setAutomaticRoute)/u);
  assert.match(source, /webSearchApi\.(setProviderConfig|setCredential|removeCredential)/u);
  assert.doesNotMatch(source, /useExaConfig|exaApi/u);
  assert.match(source, /releaseState === "shipped"/gu);
  assert.doesNotMatch(source, /releaseState === "experimental"/u);
});

test("the default surface keeps enablement, recipients, readiness, and cost visible", () => {
  assert.match(source, /Allow Web Search/u);
  assert.match(source, /<Switch[\s\S]*checked=\{snapshot\.settings\.enabled\}/u);
  assert.match(source, /aria-describedby="web-search-master-description"/u);
  assert.match(source, /Current search setup/u);
  assert.match(source, /routeProviderLabels\.join\(" → "\)/u);
  assert.match(source, /routeRecipientSummary/u);
  assert.match(source, /routeCostSummary/u);
  assert.match(source, /No listed provider is ready/u);
});

test("routing is a useful explicit disclosure with both policies preserved", () => {
  assert.match(source, /aria-expanded=\{routingExpanded\}/u);
  assert.match(source, /aria-controls="web-search-routing-options"/u);
  assert.match(source, /routingExpanded \? \(/u);
  assert.match(source, /id="web-search-routing-options"/u);
  assert.match(source, /value=\{currentSelection\.mode\}/u);
  assert.match(source, />\s*Automatic\s*<\/Text>/u);
  assert.match(source, />\s*Fixed provider\s*<\/Text>/u);
  assert.match(source, /Fixed mode never falls back/u);
});

test("automatic routing is an ordered, keyboard-operable editor", () => {
  const routeEditor = between("data-web-search-route-list", "Fallback conditions");
  const routeRow = between("function RouteEntryRow", "function ProviderSetupDialog");
  assert.match(routeEditor, /aria-label="Ordered automatic Web Search route"/u);
  assert.match(routeRow, /aria-posinset=\{index \+ 1\}/u);
  assert.match(routeRow, /aria-setsize=\{total\}/u);
  assert.match(routeRow, /event\.altKey/u);
  assert.match(routeRow, /ArrowUp|ArrowDown/u);
  assert.match(routeRow, /Move .* up|Move .* down/u);
  assert.match(routeRow, /Remove .* from automatic route/u);
  assert.match(source, /fallbackOn/u);
});

test("provider catalog supports search, disclosure filters, and provider-safe links", () => {
  assert.match(source, /type WebSearchSettingsView = "overview" \| "providers"/u);
  assert.match(source, /Back to Web Search/u);
  assert.match(source, /Browse providers/u);
  assert.match(source, /requestAnimationFrame\(\(\) => browserHeadingRef\.current\?\.focus\(\)\)/u);
  assert.match(
    source,
    /requestAnimationFrame\(\(\) => browseProvidersTriggerRef\.current\?\.focus\(\)\)/u,
  );
  assert.match(source, /data-web-search-provider-row/u);
  assert.match(source, /type="search"/u);
  assert.match(source, /Search shipped Web Search providers/u);
  assert.match(source, /role="group" aria-label="Filter providers"/u);
  for (const label of ["All", "Free", "Connected", "API key", "Existing account", "Self-hosted"]) {
    assert.match(source, new RegExp(`label: "${label.replace(" ", "\\s+")}"`, "u"));
  }
  assert.match(source, /Show \$\{moreProviders\.length\} more providers/u);
  assert.match(source, /Clear search and filters/u);
  assert.match(source, /Privacy <LinkIcon \/>/u);
  assert.match(source, /Terms <LinkIcon \/>/u);
  assert.match(source, /<ProviderIcon[\s\S]*providerLabel=\{provider\.label\}/u);
});

test("provider setup keeps credentials write-only and explains side effects", () => {
  const setup = between("function ProviderSetupDialog", "function SettingsSkeleton");
  assert.match(setup, /title=\{`Set up \$\{provider\.label\}`\}/u);
  assert.match(setup, /Setup performs no network request/u);
  assert.match(setup, /type="password"/u);
  assert.match(setup, /autoComplete="new-password"/u);
  assert.match(setup, /className="h-10 w-full"/u);
  assert.match(setup, /Keys are write-only/u);
  assert.match(setup, /Save key|Replace key/u);
  assert.match(setup, /Remove saved key/u);
  assert.match(setup, /privacyUrl/u);
  assert.match(setup, /termsUrl/u);
  assert.match(setup, /label="Connection method"/u);
  assert.match(setup, /routeMode === "api-key"/u);
  assert.doesNotMatch(setup, /Apply mode to current route|onApplyRouteMode/u);
  assert.match(setup, /role="alert" aria-live="assertive"/u);
});

test("OpenAI saved-account reuse is an explicit, separate, redacted consent path", () => {
  const setup = between("function ProviderSetupDialog", "function SettingsSkeleton");
  assert.match(setup, /supportsExistingAuth/u);
  assert.match(setup, /configuredCredentialModes\.includes\("api-key"\)/u);
  assert.match(setup, /webSearchApi\.consentExistingAuth/u);
  assert.match(setup, /webSearchApi\.revokeExistingAuth/u);
  assert.match(setup, /OpenAI Web Search model/u);
  assert.match(source, /OPENAI_EXISTING_AUTH_CONSENT_COPY/u);
  assert.match(source, /quota and billing/u);
  assert.match(setup, /Route selection is unchanged/u);
  assert.match(setup, /does not send a request/u);
  assert.match(setup, /No saved OpenAI API key is available/u);
  assert.match(setup, /Revoke approval/u);
  assert.doesNotMatch(setup, /codexAccessToken|chatgpt-account-id|credentialFingerprint/u);
});

test("settings honor reduced motion and retain authority boundaries", () => {
  assert.match(source, /motion-reduce:transition-none/u);
  assert.match(source, /motion-reduce:animate-none/u);
  assert.match(source, /Manage Bot grants/u);
  assert.match(source, /Manage schedule grants/u);
  assert.match(source, /only when search is used/u);
  assert.match(source, /never fans out/u);
});
