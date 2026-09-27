import { readImageDimensions, stripImageMetadata } from './image-dimensions.util';

/** Builds a minimal (not necessarily CRC-valid, the parser never checks that) PNG buffer
 * with a real IHDR chunk at the fixed offset the parser reads from. */
function fakePng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // signature
  buf.writeUInt32BE(13, 8); // IHDR chunk length
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

/** Minimal JPEG: SOI + a single SOF0 segment carrying width/height, nothing after. */
function fakeJpeg(width: number, height: number): Buffer {
  const buf = Buffer.alloc(19);
  buf.set([0xff, 0xd8], 0); // SOI
  buf.set([0xff, 0xc0], 2); // SOF0 marker
  buf.writeUInt16BE(17, 4); // segment length (17 bytes after the length field, incl. itself)
  buf.writeUInt8(8, 6); // precision
  buf.writeUInt16BE(height, 7);
  buf.writeUInt16BE(width, 9);
  return buf;
}

describe('readImageDimensions (B-51 avatar upload)', () => {
  it('reads PNG width/height from IHDR', () => {
    expect(readImageDimensions(fakePng(512, 512))).toEqual({ width: 512, height: 512, format: 'png' });
  });

  it('reads JPEG width/height from the SOF0 segment', () => {
    expect(readImageDimensions(fakeJpeg(300, 256))).toEqual({ width: 300, height: 256, format: 'jpeg' });
  });

  it('rejects a PNG below 256x256 by reporting its true (small) dimensions', () => {
    expect(readImageDimensions(fakePng(100, 100))).toEqual({ width: 100, height: 100, format: 'png' });
  });

  it('returns null for neither PNG nor JPEG bytes', () => {
    expect(readImageDimensions(Buffer.from('not an image'))).toBeNull();
  });

  it('returns null for a truncated/garbage buffer', () => {
    expect(readImageDimensions(Buffer.alloc(2))).toBeNull();
  });
});

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  return Buffer.concat([head, data, Buffer.alloc(4)]);
}

function jpegSegment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

describe('stripImageMetadata (B-095 — EXIF/GPS never stored)', () => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(512, 0);
  ihdr.writeUInt32BE(512, 4);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it('drops PNG text/eXIf/tIME chunks and keeps image chunks', () => {
    const png = Buffer.concat([
      signature,
      pngChunk('IHDR', ihdr),
      pngChunk('eXIf', Buffer.from('GPS 41.0,-87.0')),
      pngChunk('tEXt', Buffer.from('Comment\0secret')),
      pngChunk('IDAT', Buffer.from([1, 2, 3])),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
    const out = stripImageMetadata(png, 'png')!;
    expect(out.includes('GPS')).toBe(false);
    expect(out.includes('secret')).toBe(false);
    expect(out.equals(Buffer.concat([signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', Buffer.from([1, 2, 3])), pngChunk('IEND', Buffer.alloc(0))]))).toBe(true);
    expect(readImageDimensions(out)).toEqual({ width: 512, height: 512, format: 'png' });
  });

  it('drops JPEG APP1 (EXIF) and COM, keeps APP0, SOF and the scan data', () => {
    const sof = Buffer.alloc(15);
    sof.writeUInt8(8, 0);
    sof.writeUInt16BE(300, 1);
    sof.writeUInt16BE(400, 3);
    const app0 = jpegSegment(0xe0, Buffer.from('JFIF\0'));
    const scan = Buffer.concat([jpegSegment(0xda, Buffer.from([1, 0, 0])), Buffer.from([0x12, 0x34, 0xff, 0xd9])]);
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      app0,
      jpegSegment(0xe1, Buffer.from('Exif\0\0GPSLatitude')),
      jpegSegment(0xfe, Buffer.from('owner comment')),
      jpegSegment(0xc0, sof),
      scan,
    ]);
    const out = stripImageMetadata(jpeg, 'jpeg')!;
    expect(out.includes('GPSLatitude')).toBe(false);
    expect(out.includes('owner comment')).toBe(false);
    expect(out.equals(Buffer.concat([Buffer.from([0xff, 0xd8]), app0, jpegSegment(0xc0, sof), scan]))).toBe(true);
    expect(readImageDimensions(out)).toEqual({ width: 400, height: 300, format: 'jpeg' });
  });

  it('returns null for a truncated/malformed container instead of guessing', () => {
    const truncated = Buffer.concat([signature, pngChunk('IHDR', ihdr)]).subarray(0, 20);
    expect(stripImageMetadata(truncated, 'png')).toBeNull();
    const badJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x00]);
    expect(stripImageMetadata(badJpeg, 'jpeg')).toBeNull();
  });

  it('never throws on random bytes (parser robustness)', () => {
    for (let i = 0; i < 500; i++) {
      const len = Math.floor(Math.random() * 64);
      const buf = Buffer.from(Array.from({ length: len }, () => Math.floor(Math.random() * 256)));
      const jpegish = Buffer.concat([Buffer.from([0xff, 0xd8]), buf]);
      const pngish = Buffer.concat([signature, buf]);
      expect(() => readImageDimensions(jpegish)).not.toThrow();
      expect(() => readImageDimensions(pngish)).not.toThrow();
      expect(() => stripImageMetadata(jpegish, 'jpeg')).not.toThrow();
      expect(() => stripImageMetadata(pngish, 'png')).not.toThrow();
    }
  });
});
