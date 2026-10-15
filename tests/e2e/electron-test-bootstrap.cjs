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

// Test-only fetch rewrites. Each source origin maps to one validated loopback
// fake; every unmatched request is left untouched. The LM Studio fixture must
// receive its own default origins, so the first-run onboarding case persists
// Aiden's real default URL while discovery reaches the random-port fixture.
const redirects = new Map(); // source origin -> validated loopback URL

function loopbackOrigin(name, forbiddenPort) {
  const value = process.env[name];
  if (!value) return undefined;
  const redirect = new URL(value);
  if (
    redirect.protocol !== "http:" ||
    redirect.hostname !== "127.0.0.1" ||
    !redirect.port ||
    redirect.port === forbiddenPort ||
    redirect.pathname !== "/" ||
    redirect.search ||
    redirect.hash ||
    redirect.username ||
    redirect.password
  ) {
    throw new Error(`${name} must be a random-port HTTP loopback origin.`);
  }
  return redirect;
}

const lmStudio = loopbackOrigin("AIDEN_E2E_LMSTUDIO_REDIRECT_ORIGIN", "1234");
if (lmStudio) {
  for (const origin of ["http://127.0.0.1:1234", "http://localhost:1234"]) redirects.set(origin, lmStudio);
}
// The whole OpenRouter origin goes to the fake: the stale-catalog check and
// image generation both stay on loopback, and nothing reaches the real host.
const openRouter = loopbackOrigin("AIDEN_E2E_OPENROUTER_REDIRECT_ORIGIN", undefined);
if (openRouter) redirects.set("https://openrouter.ai", openRouter);

if (redirects.size > 0) {
  const originalFetch = globalThis.fetch.bind(globalThis);
  const RequestConstructor = globalThis.Request;
  globalThis.fetch = (input, init) => {
    const sourceUrl = new URL(input instanceof RequestConstructor ? input.url : input);
    const redirect = redirects.get(sourceUrl.origin);
    if (!redirect) return originalFetch(input, init);

    sourceUrl.protocol = redirect.protocol;
    sourceUrl.hostname = redirect.hostname;
    sourceUrl.port = redirect.port;
    if (input instanceof RequestConstructor) {
      return originalFetch(new RequestConstructor(sourceUrl, input), init);
    }
    return originalFetch(sourceUrl, init);
  };
}
