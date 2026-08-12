import { app } from "electron";

import { parseCaptureAcceptanceLaunch } from "./services/gemini-live/display-capture-acceptance-core.js";
import { configureRuntimeProfile } from "./runtime-profile.js";

const profile = configureRuntimeProfile();
const captureAcceptance = parseCaptureAcceptanceLaunch({
  argv: process.argv,
  environment: process.env,
  executablePath: process.execPath,
  appPath: app.getAppPath(),
  isPackaged: app.isPackaged,
  platform: process.platform,
  userDataPath: profile.userDataPath,
});

if (captureAcceptance.requested) {
  const { runDisplayCaptureAcceptance } = await import(
    "./services/gemini-live/display-capture-acceptance.js"
  );
  app.exit(await runDisplayCaptureAcceptance(profile));
} else {
  await import("./index.js");
}
