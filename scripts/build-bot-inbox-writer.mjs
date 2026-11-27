import { runNativeHelperBuild } from "./build-native-helper-entry.mjs";

await runNativeHelperBuild({
  name: "aiden-bot-inbox-writer",
  source: "native/bot-inbox-writer/main.c",
  testingDefine: "AIDEN_BOT_INBOX_WRITER_TESTING",
  skipMessage: "Skipping the Bot inbox writer build on this platform.",
});
