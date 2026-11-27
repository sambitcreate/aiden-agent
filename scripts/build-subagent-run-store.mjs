import { runNativeHelperBuild } from "./build-native-helper-entry.mjs";

await runNativeHelperBuild({
  name: "aiden-subagent-run-store",
  source: "native/subagent-run-store/main.c",
  testingDefine: "AIDEN_SUBAGENT_RUN_STORE_TESTING",
  skipMessage: "Skipping the private subagent run-store build on this platform.",
});
