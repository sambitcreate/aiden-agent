// `npm run models:check`: list models that each built-in provider offers on
// pi.dev but Aiden's pinned Pi catalog doesn't bundle. Warns only, never fails
// a release. Contacts only pi.dev's public, credential-free catalog endpoint
// (the one the app itself reads), never models.dev or a provider.

import { appendFile } from "node:fs/promises";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { isSelectableGoogleCatalogModel, GOOGLE_PROVIDER_ID } from "../renderer/shared/google-provider.ts";
import { readBoundedBody } from "../main/shared/bounded-body.ts";
import {
  AIDEN_PI_CATALOG_USER_AGENT,
  AIDEN_PI_CATALOG_VERSION,
  catalogVersionSupported,
  parsePiRemoteCatalog,
} from "../main/services/pi-remote-catalog.ts";
import {
  checkProviderCatalog,
  formatCatalogReport,
  type LiveCatalog,
  type ProviderCatalogCheck,
} from "./model-catalog-check-core.ts";

const CATALOG_BASE_URL = "https://pi.dev";
const TIMEOUT_MS = 20_000;
const MAX_BYTES = 5 * 1024 * 1024;
/** Providers Aiden doesn't give a pi.dev overlay (see provider-registry.ts). */
const SKIPPED = new Set(["radius"]);

function selectable(providerId: string, ids: readonly string[]): string[] {
  return providerId === GOOGLE_PROVIDER_ID ? ids.filter(isSelectableGoogleCatalogModel) : [...ids];
}

async function fetchLive(providerId: string): Promise<LiveCatalog> {
  const url = new URL(`/api/models/providers/${encodeURIComponent(providerId)}`, CATALOG_BASE_URL);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": AIDEN_PI_CATALOG_USER_AGENT },
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 404 || response.status === 501) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: "none" };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: "error", message: `HTTP ${response.status}` };
    }
    const minimum = response.headers.get("x-pi-model-catalog-minimum-version");
    if (!catalogVersionSupported(minimum)) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: "needs-pi", version: minimum ?? "newer" };
    }
    const bytes = await readBoundedBody(response, {
      maxBytes: MAX_BYTES,
      errors: {
        tooLarge: () => new Error("response too large"),
        missingBody: () => new Error("empty response"),
      },
    });
    const models = parsePiRemoteCatalog(providerId, JSON.parse(new TextDecoder().decode(bytes)), {
      // Some providers (Azure) take their endpoint from the person's setup.
      allowEmptyBaseUrl: true,
    });
    return { kind: "models", ids: models.map((model) => model.id) };
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

async function main(): Promise<void> {
  const providers = builtinProviders().filter((provider) => !SKIPPED.has(provider.id));
  const checks: ProviderCatalogCheck[] = [];
  // A few at a time: pi.dev serves each provider separately.
  for (let index = 0; index < providers.length; index += 4) {
    const batch = providers.slice(index, index + 4);
    checks.push(
      ...(await Promise.all(
        batch.map(async (provider) => {
          const live = await fetchLive(provider.id);
          const bundled = selectable(provider.id, provider.getModels().map((model) => model.id));
          return checkProviderCatalog(
            provider.id,
            bundled,
            live.kind === "models" ? { kind: "models", ids: selectable(provider.id, live.ids) } : live,
          );
        }),
      )),
    );
  }
  const report = formatCatalogReport(checks, AIDEN_PI_CATALOG_VERSION);
  process.stdout.write(report.markdown);
  if (process.env.GITHUB_ACTIONS === "true") {
    for (const warning of report.warnings) {
      process.stdout.write(`::warning title=Model catalog behind::${warning.replace(/\r?\n/gu, " ")}\n`);
    }
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, report.markdown);
  }
}

// Advisory only: a network problem or an outdated list never fails the run.
main().catch((error: unknown) => {
  process.stdout.write(`Model catalog check could not run: ${error instanceof Error ? error.message : String(error)}\n`);
});
