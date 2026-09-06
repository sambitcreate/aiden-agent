import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

const gradlePath = fileURLToPath(new URL("../android/app/build.gradle.kts", import.meta.url));
const versionPath = fileURLToPath(
  new URL("../android/app/src/main/java/sbtbiswas/AidenOnTheGo/AidenAppVersion.kt", import.meta.url),
);

test("Android clientVersion stays locked to the Gradle versionName", async () => {
  const gradle = await readFile(gradlePath, "utf8");
  const versionSource = await readFile(versionPath, "utf8");
  const gradleName = gradle.match(/versionName\s*=\s*"([^"]+)"/u)?.[1];
  const kotlinName = versionSource.match(/const val NAME = "([^"]+)"/u)?.[1];
  assert.equal(typeof gradleName, "string");
  assert.equal(kotlinName, gradleName);
  assert.match(gradle, /isMinifyEnabled = false/u);
});
