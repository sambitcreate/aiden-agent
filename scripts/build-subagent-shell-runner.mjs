import path from "node:path";
import { buildNativeCExecutable } from "./native-c-build-core.mjs";
import { runNativeHelperBuild } from "./build-native-helper-entry.mjs";

await runNativeHelperBuild({
  name: "aiden-subagent-shell-runner",
  source: "native/subagent-shell-runner/main.c",
  skipMessage: "Skipping the subagent shell-runner build on this platform.",
  async after({ executeFile, repositoryRoot, testing }) {
    if (!testing) return;
    await buildNativeCExecutable({
      executeFile,
      repositoryRoot,
      source: path.join(repositoryRoot, "native", "subagent-shell-runner", "setsid-fixture.c"),
      output: path.join(repositoryRoot, "build", "native", "aiden-subagent-shell-setsid-fixture"),
      testing: true,
      universalMac: false,
    });
  },
});
