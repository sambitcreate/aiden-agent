/* global console */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertMatchingPackageSourceFingerprint,
  packageSourceFingerprint,
  PACKAGE_SOURCE_FINGERPRINT_RELATIVE_PATH,
} from "./package-source-fingerprint.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const recorded = JSON.parse(
  await fs.readFile(path.join(repositoryRoot, PACKAGE_SOURCE_FINGERPRINT_RELATIVE_PATH), "utf8"),
);
assertMatchingPackageSourceFingerprint(
  recorded,
  await packageSourceFingerprint(repositoryRoot),
  "Package build",
);
console.log(`Verified unchanged package source fingerprint ${recorded.sha256}`);
