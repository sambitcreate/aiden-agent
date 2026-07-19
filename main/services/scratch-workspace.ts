import { randomInt } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const LEADS = [
  "day",
  "calm",
  "kind",
  "blue",
  "fair",
  "keen",
  "mild",
  "neat",
  "bold",
  "cozy",
  "warm",
  "cool",
];
const NOUNS = [
  "game",
  "code",
  "bird",
  "dune",
  "fern",
  "moon",
  "star",
  "tree",
  "wave",
  "path",
  "pond",
  "rain",
];
const VERBS = [
  "run",
  "make",
  "grow",
  "roam",
  "sail",
  "spin",
  "jump",
  "play",
  "read",
  "draw",
  "hike",
  "glow",
];

type RandomIndex = (maxExclusive: number) => number;

const secureRandomIndex: RandomIndex = (maxExclusive) => randomInt(maxExclusive);

function pick(words: readonly string[], randomIndex: RandomIndex): string {
  return words[randomIndex(words.length)];
}

/** Generate a readable three-word slug whose words are each three or four letters. */
export function generateScratchWorkspaceName(randomIndex: RandomIndex = secureRandomIndex): string {
  return [pick(LEADS, randomIndex), pick(NOUNS, randomIndex), pick(VERBS, randomIndex)].join("-");
}

/** Create a unique private scratch directory under ~/aiden without overwriting anything. */
export async function createScratchWorkspaceDirectory(
  root = path.join(os.homedir(), "aiden"),
  randomIndex: RandomIndex = secureRandomIndex,
): Promise<{ name: string; folderPath: string }> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 64; attempt += 1) {
    const name = generateScratchWorkspaceName(randomIndex);
    const folderPath = path.join(root, name);
    try {
      await fs.mkdir(folderPath, { mode: 0o700 });
      return { name, folderPath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  throw new Error("Could not create a unique scratch workspace. Try again.");
}
