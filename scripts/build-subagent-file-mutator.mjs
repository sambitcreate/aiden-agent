import { runNativeHelperBuild } from "./build-native-helper-entry.mjs";

await runNativeHelperBuild({
  name: "aiden-subagent-file-mutator",
  source: "native/subagent-file-mutator/main.c",
  testingDefine: "AIDEN_SUBAGENT_FILE_MUTATOR_TESTING",
  skipMessage: "Skipping the subagent file-mutator build on this platform.",
});
