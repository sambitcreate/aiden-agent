import { Buffer } from "node:buffer";
import console from "node:console";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PNG } from "pngjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ONBOARDING_ASSETS = path.join(repositoryRoot, "renderer", "assets", "onboarding");
const MAX_COLORS = 256;

function boxStats(colors) {
  const min = [255, 255, 255, 255];
  const max = [0, 0, 0, 0];
  let population = 0;
  for (const [key, count] of colors) {
    population += count;
    for (let channel = 0; channel < 4; channel += 1) {
      const value = (key >>> (24 - channel * 8)) & 0xff;
      if (value < min[channel]) min[channel] = value;
      if (value > max[channel]) max[channel] = value;
    }
  }
  let channel = 0;
  for (let candidate = 1; candidate < 4; candidate += 1) {
    if (max[candidate] - min[candidate] > max[channel] - min[channel]) channel = candidate;
  }
  return { colors, population, channel, range: max[channel] - min[channel] };
}

function splitBox(box) {
  const shift = 24 - box.channel * 8;
  const sorted = [...box.colors].sort((a, b) => ((a[0] >>> shift) & 0xff) - ((b[0] >>> shift) & 0xff));
  let seen = 0;
  let cut = 1;
  for (; cut < sorted.length; cut += 1) {
    seen += sorted[cut - 1][1];
    if (seen * 2 >= box.population) break;
  }
  cut = Math.min(Math.max(cut, 1), sorted.length - 1);
  return [boxStats(sorted.slice(0, cut)), boxStats(sorted.slice(cut))];
}

function averageColor(box) {
  const sums = [0, 0, 0, 0];
  for (const [key, count] of box.colors) {
    for (let channel = 0; channel < 4; channel += 1) {
      sums[channel] += ((key >>> (24 - channel * 8)) & 0xff) * count;
    }
  }
  return sums.map((sum) => Math.round(sum / box.population));
}

function medianCutPalette(colors, size) {
  const boxes = [boxStats(colors)];
  while (boxes.length < size) {
    let best = -1;
    let bestScore = 0;
    for (let index = 0; index < boxes.length; index += 1) {
      const box = boxes[index];
      const score = box.colors.length > 1 ? box.range * box.population : 0;
      if (score > bestScore) {
        best = index;
        bestScore = score;
      }
    }
    if (best < 0) break;
    boxes.splice(best, 1, ...splitBox(boxes[best]));
  }
  return boxes.map(averageColor);
}

function nearest(palette, key) {
  const source = [key >>> 24, (key >>> 16) & 0xff, (key >>> 8) & 0xff, key & 0xff];
  let best = palette[0];
  let bestDistance = Infinity;
  for (const color of palette) {
    let distance = 0;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = source[channel] - color[channel];
      distance += delta * delta;
    }
    if (distance < bestDistance) {
      best = color;
      bestDistance = distance;
    }
  }
  return best;
}

// Lloyd (k-means) passes move each median-cut color to the weighted centroid
// of the colors that map to it, which removes most visible banding.
function refinePalette(colors, palette, iterations = 4) {
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sums = palette.map(() => [0, 0, 0, 0, 0]);
    for (const [key, count] of colors) {
      const sum = sums[palette.indexOf(nearest(palette, key))];
      sum[0] += (key >>> 24) * count;
      sum[1] += ((key >>> 16) & 0xff) * count;
      sum[2] += ((key >>> 8) & 0xff) * count;
      sum[3] += (key & 0xff) * count;
      sum[4] += count;
    }
    palette = palette.map((color, index) => {
      const sum = sums[index];
      return sum[4] === 0 ? color : sum.slice(0, 4).map((value) => Math.round(value / sum[4]));
    });
  }
  return palette;
}

const pixelKey = (pixels, offset) => pixels[offset + 3] === 0
  ? 0
  : ((pixels[offset] << 24) | (pixels[offset + 1] << 16) | (pixels[offset + 2] << 8) | pixels[offset + 3]) >>> 0;

/**
 * Reduces an RGBA bitmap to at most `maxColors` distinct colors with weighted
 * median cut and returns new RGBA pixels. The output stays 8-bit RGBA (PNG
 * color type 6) because the onboarding contract requires truecolor-with-alpha
 * illustrations; fewer distinct colors simply deflate far better.
 *
 * Opaque and translucent pixels get separate palettes, so fully opaque pixels
 * stay fully opaque and fully transparent pixels stay fully transparent (with
 * zeroed RGB): silhouettes never gain halos or holes. An image that already
 * has `maxColors` or fewer colors is returned unchanged apart from zeroing the
 * RGB of transparent pixels, which keeps the script idempotent.
 */
export function quantizeRgba(pixels, maxColors = MAX_COLORS) {
  const histogram = new Map();
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const key = pixelKey(pixels, offset);
    histogram.set(key, (histogram.get(key) ?? 0) + 1);
  }
  const output = Buffer.from(pixels);
  for (let offset = 0; offset < output.length; offset += 4) {
    if (output[offset + 3] === 0) output.fill(0, offset, offset + 4);
  }
  if (histogram.size <= maxColors) return output;

  const opaque = [];
  const translucent = [];
  for (const entry of histogram) {
    if (entry[0] === 0) continue;
    ((entry[0] & 0xff) === 255 ? opaque : translucent).push(entry);
  }
  const budget = maxColors - (histogram.has(0) ? 1 : 0);
  const translucentSize = translucent.length === 0
    ? 0
    : Math.min(translucent.length, Math.max(1, Math.round((budget * translucent.length) / (histogram.size - 1))));
  const opaqueSize = Math.min(opaque.length, budget - translucentSize);
  const opaquePalette = opaque.length > 0 ? refinePalette(opaque, medianCutPalette(opaque, opaqueSize)) : [];
  const translucentPalette = translucent.length > 0 ? refinePalette(translucent, medianCutPalette(translucent, translucentSize)) : [];

  const mapping = new Map([[0, [0, 0, 0, 0]]]);
  for (const [key] of opaque) mapping.set(key, nearest(opaquePalette, key));
  for (const [key] of translucent) mapping.set(key, nearest(translucentPalette, key));
  for (let offset = 0; offset < pixels.length; offset += 4) {
    output.set(mapping.get(pixelKey(pixels, offset)), offset);
  }
  return output;
}

/** Re-encodes a PNG as quantized 8-bit RGBA at the same dimensions. */
export function optimizePng(buffer) {
  const image = PNG.sync.read(buffer);
  const optimized = new PNG({ width: image.width, height: image.height });
  optimized.data = quantizeRgba(image.data);
  // pngjs defaults to the RLE deflate strategy; the default strategy with the
  // best of a few row filters is markedly smaller for flat illustrations.
  return [-1, 1, 4]
    .map((filterType) => PNG.sync.write(optimized, {
      colorType: 6,
      inputColorType: 6,
      bitDepth: 8,
      deflateLevel: 9,
      deflateStrategy: 0,
      filterType,
    }))
    .reduce((smallest, candidate) => (candidate.length < smallest.length ? candidate : smallest));
}

async function pngFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return pngFiles(entryPath);
    return entry.name.endsWith(".png") ? [entryPath] : [];
  }));
  return nested.flat().sort();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let before = 0;
  let after = 0;
  for (const file of await pngFiles(ONBOARDING_ASSETS)) {
    const original = await readFile(file);
    const optimized = optimizePng(original);
    before += original.length;
    // Never replace an asset with a larger encoding.
    const kept = optimized.length < original.length ? optimized : original;
    if (kept !== original) await writeFile(file, kept);
    after += kept.length;
    console.log(`${path.relative(repositoryRoot, file)}: ${original.length} -> ${kept.length} bytes`);
  }
  console.log(`onboarding assets: ${before} -> ${after} bytes`);
}
