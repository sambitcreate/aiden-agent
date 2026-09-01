/* global console, process */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PI_AI_VERSION = "0.84.4";
const PI_PACKAGE_PATH = path.join("node_modules", "@earendil-works", "pi-ai");
const PI_LOGO_PREFIX = "const LOGO_SVG = `<svg";
const AIDEN_LOGO_PREFIX = 'const LOGO_SVG = `<img src="data:image/png;base64,';
const SUCCESS_FUNCTION = `export function oauthSuccessHtml(message) {
    return renderPage({
        title: "Authentication successful",
        heading: "Authentication successful",
        message,
    });
}`;
const BRANDED_SUCCESS_FUNCTION = `export function oauthSuccessHtml(message) {
    return renderPage({
        title: "Aiden Agent sign-in successful",
        heading: "Aiden Agent sign-in successful",
        message,
    });
}`;
const ERROR_FUNCTION = `export function oauthErrorHtml(message, details) {
    return renderPage({
        title: "Authentication failed",
        heading: "Authentication failed",
        message,
        details,
    });
}`;
const BRANDED_ERROR_FUNCTION = `export function oauthErrorHtml(message, details) {
    return renderPage({
        title: "Aiden Agent sign-in failed",
        heading: "Aiden Agent sign-in failed",
        message,
        details,
    });
}`;
const OPENAI_SUCCESS_CALL =
  'oauthSuccessHtml("OpenAI authentication completed. You can close this window.")';
const AIDEN_OPENAI_SUCCESS_CALL =
  'oauthSuccessHtml("Your ChatGPT account is connected to Aiden Agent. You can close this window.")';

function replaceExact(source, before, after, label) {
  const beforeCount = source.split(before).length - 1;
  const afterCount = source.split(after).length - 1;
  if (beforeCount === 1 && afterCount === 0) return source.replace(before, after);
  if (beforeCount === 0 && afterCount === 1) return source;
  throw new Error(`Pi OAuth ${label} changed unexpectedly; review the branding patch.`);
}

function replaceLogo(source, brandedLogo) {
  if (source.includes(brandedLogo)) return source;
  const brandedStart = source.indexOf(AIDEN_LOGO_PREFIX);
  const brandedEnd = brandedStart < 0 ? -1 : source.indexOf(" />`;", brandedStart);
  if (brandedStart >= 0) {
    if (brandedEnd < 0 || source.indexOf(AIDEN_LOGO_PREFIX, brandedStart + 1) >= 0) {
      throw new Error("Aiden OAuth logo changed unexpectedly; review the branding patch.");
    }
    return `${source.slice(0, brandedStart)}${brandedLogo}${source.slice(brandedEnd + " />`;".length)}`;
  }
  const start = source.indexOf(PI_LOGO_PREFIX);
  const end = start < 0 ? -1 : source.indexOf("</svg>`;", start);
  if (start < 0 || end < 0 || source.indexOf(PI_LOGO_PREFIX, start + 1) >= 0) {
    throw new Error("Pi OAuth logo changed unexpectedly; review the branding patch.");
  }
  return `${source.slice(0, start)}${brandedLogo}${source.slice(end + "</svg>`;".length)}`;
}

export async function patchPiOAuthBranding(projectRoot) {
  const packageRoot = path.join(projectRoot, PI_PACKAGE_PATH);
  const packageJsonPath = path.join(packageRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  if (packageJson.version !== PI_AI_VERSION) {
    throw new Error(
      `Expected @earendil-works/pi-ai ${PI_AI_VERSION}, received ${String(packageJson.version)}. Review the OAuth branding patch before upgrading Pi.`,
    );
  }

  const icon = await readFile(path.join(projectRoot, "resources", "app-icon.png"));
  const brandedLogo = `const LOGO_SVG = \`<img src="data:image/png;base64,${icon.toString("base64")}" alt="" style="display:block;width:100%;height:100%;border-radius:16px" />\`;`;
  const oauthPagePath = path.join(packageRoot, "dist", "auth", "oauth", "oauth-page.js");
  const openAiCodexPath = path.join(packageRoot, "dist", "auth", "oauth", "openai-codex.js");

  const originalPage = await readFile(oauthPagePath, "utf8");
  let page = replaceLogo(originalPage, brandedLogo);
  page = replaceExact(page, SUCCESS_FUNCTION, BRANDED_SUCCESS_FUNCTION, "success page");
  page = replaceExact(page, ERROR_FUNCTION, BRANDED_ERROR_FUNCTION, "error page");

  const originalOpenAi = await readFile(openAiCodexPath, "utf8");
  const openAi = replaceExact(
    originalOpenAi,
    OPENAI_SUCCESS_CALL,
    AIDEN_OPENAI_SUCCESS_CALL,
    "ChatGPT success message",
  );

  if (page !== originalPage) await writeFile(oauthPagePath, page);
  if (openAi !== originalOpenAi) await writeFile(openAiCodexPath, openAi);
  return { changed: page !== originalPage || openAi !== originalOpenAi };
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  patchPiOAuthBranding(projectRoot)
    .then(({ changed }) => {
      console.log(changed ? "Applied Aiden OAuth branding to Pi." : "Aiden OAuth branding is current.");
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
