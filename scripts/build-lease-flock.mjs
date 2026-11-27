import { runNativeHelperBuild } from "./build-native-helper-entry.mjs";

await runNativeHelperBuild({
  name: "aiden-lease-flock",
  source: "native/lease-flock/main.c",
  testing: false,
  skipMessage: "Skipping the lease flock helper build on this platform.",
});
