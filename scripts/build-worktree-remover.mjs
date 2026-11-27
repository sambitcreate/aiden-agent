import { runNativeHelperBuild } from "./build-native-helper-entry.mjs";

await runNativeHelperBuild({
  name: "aiden-worktree-remover",
  source: "native/worktree-remover/main.c",
  testingDefine: "AIDEN_REMOVER_TESTING",
  skipMessage: "Skipping the managed-worktree remover build on this platform.",
});
