import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import sharp, { type Metadata, type OutputInfo } from 'sharp';
import { FileInvalidError, FileTypeNotAllowedError } from '../common/errors';

/** The only formats accepted. No SVG (it is a document that can run script), no GIF, no HEIC. */
export const IMAGE_FORMATS = {
  jpeg: { mime: 'image/jpeg', ext: 'jpg' },
  png: { mime: 'image/png', ext: 'png' },
  webp: { mime: 'image/webp', ext: 'webp' },
} as const;
export type ImageFormat = keyof typeof IMAGE_FORMATS;
export const ALLOWED_IMAGE_MIME_TYPES = Object.values(IMAGE_FORMATS).map((f) => f.mime);

/** Names that are never accepted, whatever the bytes say. */
const DANGEROUS_EXTENSION =
  /\.(exe|dll|bat|cmd|com|msi|sh|bash|ps1|psm1|vbs|js|mjs|cjs|jar|php\d?|phtml|asp|aspx|jsp|cgi|pl|py|rb|html?|xhtml|svgz?|xml|hta|scr|lnk|app|apk|deb|rpm)$/i;

export interface ImageRules {
  minEdge: number;
  maxEdge: number;
  maxPixels: number;
  /** The stored image is scaled down to fit inside this square. */
  maxOutputEdge: number;
}

export interface ProcessedImage {
  format: ImageFormat;
  mimeType: string;
  ext: string;
  width: number;
  height: number;
  sizeBytes: number;
  /** SHA-256 of the stored bytes, base64. */
  checksum: string;
}

/**
 * The format the first bytes are, or null. The client's MIME type and file
 * name are never what decides this.
 */
export async function sniffImageFormat(path: string): Promise<ImageFormat | null> {
  const handle = await open(path, 'r');
  try {
    const head = Buffer.alloc(16);
    const { bytesRead } = await handle.read(head, 0, 16, 0);
    if (bytesRead < 12) return null;
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
    if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
      return 'png';
    if (head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP')
      return 'webp';
    return null;
  } finally {
    await handle.close();
  }
}

/** Cheap checks on what the client claimed, before any decoding. */
export function checkClaims(claimedMime: string, originalName: string): void {
  if (!(ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(claimedMime.toLowerCase())) {
    throw new FileTypeNotAllowedError(ALLOWED_IMAGE_MIME_TYPES);
  }
  if (DANGEROUS_EXTENSION.test(originalName.trim()))
    throw new FileTypeNotAllowedError(ALLOWED_IMAGE_MIME_TYPES);
}

/**
 * Validate and re-encode an uploaded image, from one file on disk to another.
 *
 *   1. The magic bytes must be JPEG, PNG or WebP.
 *   2. libvips must decode it (`failOn: 'error'`), as that same format, within
 *      `maxPixels` — a 50 000 × 50 000 "decompression bomb" is refused before
 *      it is decoded into memory.
 *   3. Its dimensions must be within [minEdge, maxEdge].
 *   4. It is re-encoded: EXIF orientation applied, then ALL metadata dropped
 *      (camera, GPS location, comments), scaled to fit `maxOutputEdge`. What
 *      is stored is pixels this server wrote — a polyglot file (an image that
 *      is also a script or an archive) does not survive the round trip.
 *
 * libvips streams from disk; the image is never read into a JS buffer.
 */
export async function processImage(
  inputPath: string,
  outputPath: string,
  rules: ImageRules,
): Promise<ProcessedImage> {
  const format = await sniffImageFormat(inputPath);
  if (!format) throw new FileTypeNotAllowedError(ALLOWED_IMAGE_MIME_TYPES);

  const decoderOptions = {
    limitInputPixels: rules.maxPixels,
    failOn: 'error' as const,
    sequentialRead: true,
  };
  let metadata: Metadata;
  try {
    metadata = await sharp(inputPath, decoderOptions).metadata();
  } catch (error) {
    if (/pixel limit/i.test((error as Error).message)) {
      throw new FileInvalidError('The image has too many pixels.', { maxPixels: rules.maxPixels });
    }
    throw new FileInvalidError();
  }
  if (metadata.format !== format) throw new FileInvalidError();
  const { width, height } = orientedSize(metadata);
  if (!width || !height) throw new FileInvalidError();
  if (width < rules.minEdge || height < rules.minEdge) {
    throw new FileInvalidError(
      `The image must be at least ${rules.minEdge} × ${rules.minEdge} pixels.`,
      {
        width,
        height,
        minEdge: rules.minEdge,
      },
    );
  }
  if (width > rules.maxEdge || height > rules.maxEdge) {
    throw new FileInvalidError(`The image must be at most ${rules.maxEdge} pixels on each side.`, {
      width,
      height,
      maxEdge: rules.maxEdge,
    });
  }

  let info: OutputInfo;
  try {
    const pipeline = sharp(inputPath, decoderOptions)
      .rotate()
      .resize({
        width: rules.maxOutputEdge,
        height: rules.maxOutputEdge,
        fit: 'inside',
        withoutEnlargement: true,
      });
    const encoded =
      format === 'jpeg'
        ? pipeline.jpeg({ quality: 85, mozjpeg: true })
        : format === 'png'
          ? pipeline.png({ compressionLevel: 9 })
          : pipeline.webp({ quality: 85 });
    info = await encoded.toFile(outputPath);
  } catch {
    throw new FileInvalidError();
  }

  const { size } = await stat(outputPath);
  return {
    format,
    mimeType: IMAGE_FORMATS[format].mime,
    ext: IMAGE_FORMATS[format].ext,
    width: info.width,
    height: info.height,
    sizeBytes: size,
    checksum: await sha256File(outputPath),
  };
}

/** Width and height as displayed, after EXIF orientation 5–8 swaps them. */
function orientedSize(metadata: Metadata): { width?: number; height?: number } {
  const swap = (metadata.orientation ?? 1) >= 5;
  return swap
    ? { width: metadata.height, height: metadata.width }
    : { width: metadata.width, height: metadata.height };
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('base64');
}

/** A display name: no directories, no control characters, bounded. */
export function sanitiseFileName(name: string, ext: string): string {
  const base = [...(name.split(/[\\/]/).pop() ?? '')]
    .filter((c) => c.charCodeAt(0) > 0x1f && c.charCodeAt(0) !== 0x7f && !'"<>|:*?'.includes(c))
    .join('')
    .replace(/\.[^.]*$/, '')
    .trim()
    .slice(0, 100);
  return `${base || 'image'}.${ext}`;
}
