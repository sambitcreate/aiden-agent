import { configureRuntimeProfile } from "./runtime-profile.js";

if (process.argv.includes("--aiden-performance-runtime-info")) {
  process.stdout.write(
    `${JSON.stringify({
      nodeVersion: process.versions.node,
      electronVersion: process.versions.electron,
      platform: process.platform,
      architecture: process.arch,
    })}\n`,
  );
  process.exit(0);
}

configureRuntimeProfile();
await import("./index.js");
