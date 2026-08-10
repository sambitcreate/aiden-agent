"use strict";

const process = require("node:process");
const { URL } = require("node:url");
const { app } = require("electron");

// Electron resolves its native home directory independently from Node's HOME
// on macOS. Point both at the fixture root before Aiden's runtime-profile
// bootstrap reads app.getPath("home").
const testHome = process.env.HOME;
if (!testHome) throw new Error("The Electron E2E bootstrap requires an isolated HOME.");
app.setPath("home", testHome);

// The fresh-config onboarding case must persist Aiden's real default LM Studio
// URL while discovery still reaches its own random-port fixture. Rewrite only
// that exact loopback origin before app code (and Pi) capture global fetch;
// every other request is left untouched.
const REDIRECT_ENV = "AIDEN_E2E_LMSTUDIO_REDIRECT_ORIGIN";
const DEFAULT_LM_STUDIO_ORIGINS = new Set(["http://127.0.0.1:1234", "http://localhost:1234"]);
const configuredOrigin = process.env[REDIRECT_ENV];

if (configuredOrigin) {
  const redirect = new URL(configuredOrigin);
  if (
    redirect.protocol !== "http:" ||
    redirect.hostname !== "127.0.0.1" ||
    !redirect.port ||
    redirect.port === "1234" ||
    redirect.pathname !== "/" ||
    redirect.search ||
    redirect.hash ||
    redirect.username ||
    redirect.password
  ) {
    throw new Error(`${REDIRECT_ENV} must be a random-port HTTP loopback origin.`);
  }

  const originalFetch = globalThis.fetch.bind(globalThis);
  const RequestConstructor = globalThis.Request;
  globalThis.fetch = (input, init) => {
    const sourceUrl = new URL(input instanceof RequestConstructor ? input.url : input);
    if (!DEFAULT_LM_STUDIO_ORIGINS.has(sourceUrl.origin)) {
      return originalFetch(input, init);
    }

    sourceUrl.protocol = redirect.protocol;
    sourceUrl.hostname = redirect.hostname;
    sourceUrl.port = redirect.port;
    if (input instanceof RequestConstructor) {
      return originalFetch(new RequestConstructor(sourceUrl, input), init);
    }
    return originalFetch(sourceUrl, init);
  };
}
