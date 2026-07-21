const PNG_DATA_URL_PREFIX = "data:image/png;base64,";
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const MAX_SHARE_IMAGE_BYTES = 16 * 1024 * 1024;

export const PROFILE_SHARE_WIDTH = 1200;
export const PROFILE_SHARE_HEIGHT = 1600;

function pngCrc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validatePngStructure(image: Buffer): void {
  let offset = PNG_SIGNATURE.length;
  let chunkIndex = 0;
  let sawIdat = false;

  while (offset + 12 <= image.length) {
    const length = image.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = typeStart + 4;
    const crcOffset = dataStart + length;
    const nextOffset = crcOffset + 4;
    if (length > MAX_SHARE_IMAGE_BYTES || nextOffset > image.length) {
      throw new Error("The profile snapshot has a malformed PNG chunk.");
    }

    const type = image.toString("ascii", typeStart, dataStart);
    if (!/^[A-Za-z]{4}$/u.test(type)) {
      throw new Error("The profile snapshot has an invalid PNG chunk type.");
    }
    if (image.readUInt32BE(crcOffset) !== pngCrc32(image.subarray(typeStart, crcOffset))) {
      throw new Error("The profile snapshot failed its PNG integrity check.");
    }

    if (chunkIndex === 0) {
      if (type !== "IHDR" || length !== 13) {
        throw new Error("The profile snapshot is missing PNG dimensions.");
      }
      if (
        image.readUInt32BE(dataStart) !== PROFILE_SHARE_WIDTH ||
        image.readUInt32BE(dataStart + 4) !== PROFILE_SHARE_HEIGHT
      ) {
        throw new Error("The profile snapshot must use Aiden's 3:4 share size.");
      }
      const bitDepth = image[dataStart + 8];
      const colorType = image[dataStart + 9];
      const validBitDepth =
        (colorType === 0 && [1, 2, 4, 8, 16].includes(bitDepth ?? -1)) ||
        (colorType === 2 && [8, 16].includes(bitDepth ?? -1)) ||
        (colorType === 3 && [1, 2, 4, 8].includes(bitDepth ?? -1)) ||
        ((colorType === 4 || colorType === 6) && [8, 16].includes(bitDepth ?? -1));
      if (
        !validBitDepth ||
        image[dataStart + 10] !== 0 ||
        image[dataStart + 11] !== 0 ||
        ![0, 1].includes(image[dataStart + 12] ?? -1)
      ) {
        throw new Error("The profile snapshot uses an unsupported PNG format.");
      }
    } else if (type === "IHDR") {
      throw new Error("The profile snapshot contains duplicate PNG dimensions.");
    }

    if (type === "IDAT") sawIdat = true;
    if (type === "IEND") {
      if (length !== 0 || !sawIdat || nextOffset !== image.length) {
        throw new Error("The profile snapshot has an incomplete PNG payload.");
      }
      return;
    }

    chunkIndex += 1;
    offset = nextOffset;
  }

  throw new Error("The profile snapshot has an incomplete PNG payload.");
}

export function decodeProfileSharePng(dataUrl: unknown): Buffer {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith(PNG_DATA_URL_PREFIX)) {
    throw new Error("The profile snapshot must be a PNG image.");
  }
  const encoded = dataUrl.slice(PNG_DATA_URL_PREFIX.length);
  if (!encoded || encoded.length > Math.ceil((MAX_SHARE_IMAGE_BYTES * 4) / 3) + 4) {
    throw new Error("The profile snapshot is empty or too large.");
  }
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
    throw new Error("The profile snapshot is not valid base64 data.");
  }

  const image = Buffer.from(encoded, "base64");
  if (image.length < 24 || image.length > MAX_SHARE_IMAGE_BYTES) {
    throw new Error("The profile snapshot is empty or too large.");
  }
  if (!image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("The profile snapshot has an invalid PNG signature.");
  }
  if (image.toString("base64") !== encoded) {
    throw new Error("The profile snapshot is not canonical base64 data.");
  }
  validatePngStructure(image);
  return image;
}
