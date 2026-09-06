import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

const gradlePath = fileURLToPath(new URL("../android/app/build.gradle.kts", import.meta.url));
const versionPath = fileURLToPath(
  new URL("../android/app/src/main/java/sbtbiswas/AidenOnTheGo/AidenAppVersion.kt", import.meta.url),
);
const motionPath = fileURLToPath(
  new URL("../android/app/src/main/java/sbtbiswas/AidenOnTheGo/ui/theme/AidenMotion.kt", import.meta.url),
);
const pairingPath = fileURLToPath(
  new URL(
    "../android/app/src/main/java/sbtbiswas/AidenOnTheGo/features/remote/AidenPairingScreen.kt",
    import.meta.url,
  ),
);
const scannerPath = fileURLToPath(
  new URL(
    "../android/app/src/main/java/sbtbiswas/AidenOnTheGo/features/remote/AidenQRCodeScanner.kt",
    import.meta.url,
  ),
);
const versionTestPath = fileURLToPath(
  new URL("../android/app/src/test/java/sbtbiswas/AidenOnTheGo/AidenAppVersionTest.kt", import.meta.url),
);

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

test("Android clientVersion stays locked to the Gradle versionName", async () => {
  const gradle = await readFile(gradlePath, "utf8");
  const versionSource = await readFile(versionPath, "utf8");
  const versionTest = await readFile(versionTestPath, "utf8");
  const gradleName = gradle.match(/versionName\s*=\s*"([^"]+)"/u)?.[1];
  assert.equal(typeof gradleName, "string");
  assert.match(gradle, /buildConfig\s*=\s*true/u);
  assert.match(gradle, /isMinifyEnabled = false/u);
  assert.match(versionSource, /val NAME:\s*String\s*=\s*BuildConfig\.VERSION_NAME/u);
  assert.doesNotMatch(versionSource, /const val NAME = "/u);
  assert.match(versionTest, /assertEquals\(BuildConfig\.VERSION_NAME, AidenAppVersion\.NAME\)/u);
});

test("Android pairing filters match the Crockford setup-code alphabet", async () => {
  const pairing = await readFile(pairingPath, "utf8");
  assert.match(pairing, new RegExp(`filter \\{ it in "${CROCKFORD}" \\}`, "u"));
  assert.doesNotMatch(pairing, /ABCDEFGHJKMNPQRSTVWXYZIL/u);
  assert.match(pairing, /fun handleScannedQRCode[\s\S]*if \(isPairing\) return/u);
  assert.match(pairing, /if \(!isPairing\) \{\s*AidenQRCodeScanner\(/u);
});

test("Android QR scanner cannot bind or deliver after dispose", async () => {
  const scanner = await readFile(scannerPath, "utf8");
  assert.match(scanner, /androidx\.lifecycle\.compose\.LocalLifecycleOwner/u);
  assert.doesNotMatch(scanner, /androidx\.compose\.ui\.platform\.LocalLifecycleOwner/u);
  assert.match(scanner, /val closed = remember \{ AtomicBoolean\(false\) \}/u);
  assert.match(scanner, /val delivered = remember \{ AtomicBoolean\(false\) \}/u);
  assert.match(scanner, /if \(closed\.get\(\)\) return@addListener/u);
  assert.match(scanner, /delivered\.compareAndSet\(false, true\)/u);
  assert.match(scanner, /cameraExecutor\.shutdownNow\(\)/u);
});

test("visual-only tactilePress observes pointer events without consuming them", async () => {
  const motion = await readFile(motionPath, "utf8");
  assert.match(motion, /PointerEventPass\.Final/u);
  assert.match(motion, /if \(onClick == null\)/u);
  assert.match(motion, /awaitPointerEvent\(PointerEventPass\.Final\)/u);
});
