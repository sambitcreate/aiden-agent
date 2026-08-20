/* global console */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { writePackageSourceFingerprint } from "./package-source-fingerprint.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { fingerprint, target } = await writePackageSourceFingerprint(repositoryRoot);
console.log(`Package source fingerprint ${fingerprint.sha256} written to ${target}`);
