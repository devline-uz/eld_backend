/**
 * B-51 — `POST /me/avatar` accepts PNG/JPG >= 256x256 and nothing else. No `sharp`/
 * `image-size` dependency: both formats' dimensions live in a fixed, well-known header
 * position, so a couple of dozen lines of buffer parsing avoids adding a native/binary
 * dependency for one field-level check.
 */
export interface ImageDimensions {
  width: number;
  height: number;
  format: 'png' | 'jpeg';
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readPng(buf: Buffer): ImageDimensions | null {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  // IHDR is always the first chunk, right after the 8-byte signature + 4-byte length + "IHDR".
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height, format: 'png' };
}

function readJpeg(buf: Buffer): ImageDimensions | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 <= buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buf[offset + 1];
    // SOFn markers (0xC0-0xCF, excluding the DHT/JPG-extension markers) carry the frame
    // dimensions; every other marker's payload is skipped via its own length prefix.
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    const segmentLength = buf.readUInt16BE(offset + 2);
    if (isSof) {
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      return { width, height, format: 'jpeg' };
    }
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    offset += 2 + segmentLength;
  }
  return null;
}

/** Returns `null` for anything that is not a well-formed PNG or JPEG. */
export function readImageDimensions(buf: Buffer): ImageDimensions | null {
  return readPng(buf) ?? readJpeg(buf);
}

/** PNG ancillary chunks that carry free text, EXIF (GPS, device serials) or timestamps. */
const PNG_METADATA_CHUNKS = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

function stripPng(buf: Buffer): Buffer | null {
  const parts: Buffer[] = [buf.subarray(0, 8)];
  let offset = 8;
  while (offset < buf.length) {
    if (offset + 12 > buf.length) return null;
    const length = buf.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > buf.length) return null;
    const type = buf.toString('ascii', offset + 4, offset + 8);
    if (!PNG_METADATA_CHUNKS.has(type)) parts.push(buf.subarray(offset, end));
    offset = end;
    if (type === 'IEND') break;
  }
  return Buffer.concat(parts);
}

function stripJpeg(buf: Buffer): Buffer | null {
  const parts: Buffer[] = [buf.subarray(0, 2)];
  let offset = 2;
  while (offset < buf.length) {
    if (buf[offset] !== 0xff || offset + 1 >= buf.length) return null;
    const marker = buf[offset + 1];
    if (marker === 0xff) {
      offset += 1; // fill byte
      continue;
    }
    // Standalone markers (RSTn, TEM, EOI) have no length field.
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xd9) {
      parts.push(buf.subarray(offset, offset + 2));
      offset += 2;
      if (marker === 0xd9) break;
      continue;
    }
    if (offset + 4 > buf.length) return null;
    const end = offset + 2 + buf.readUInt16BE(offset + 2);
    if (end > buf.length || end <= offset + 2) return null;
    if (marker === 0xda) {
      // Start of scan: entropy-coded data follows up to EOI — no further metadata segments.
      parts.push(buf.subarray(offset));
      break;
    }
    // Drop APP1..APP15 (EXIF/GPS, XMP, maker notes, Photoshop IRB) and COM; keep APP0 (JFIF).
    const isMetadata = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!isMetadata) parts.push(buf.subarray(offset, end));
    offset = end;
  }
  return Buffer.concat(parts);
}

/**
 * B-095 — TZ controls "EXIF stripped": returns a copy of the image with every metadata
 * segment/chunk removed (EXIF GPS position, camera serials, XMP, comments, text chunks), or
 * `null` when the container structure is malformed (the upload is then refused). Pixel data
 * is copied byte-for-byte; nothing is decoded or re-encoded.
 */
export function stripImageMetadata(buf: Buffer, format: ImageDimensions['format']): Buffer | null {
  return format === 'png' ? stripPng(buf) : stripJpeg(buf);
}
