/**
 * Web chat voice messages — validation helpers for an uploaded audio clip.
 *
 * The browser's `MediaRecorder` produces `audio/webm;codecs=opus` (Chrome/Edge/Firefox) or
 * `audio/mp4` (Safari); the other entries cover uploads from other recorders. The declared MIME
 * type must agree with the file's magic bytes, so a renamed HTML/JS file can never be stored and
 * later served back under an `audio/*` content type.
 */

/** 10 MiB — roughly 10+ minutes of Opus; enforced while streaming (multer) and again in the service. */
export const MESSAGE_AUDIO_MAX_BYTES = 10 * 1024 * 1024;
/** Longest accepted voice message (client-reported duration). */
export const MESSAGE_AUDIO_MAX_DURATION_MS = 5 * 60 * 1000;
/** `Attachment.kind` of a chat voice message. */
export const MESSAGE_AUDIO_KIND = 'MESSAGE_AUDIO';
/** Plain-text `Message.body` of a voice message — what clients that do not render audio show. */
export const MESSAGE_AUDIO_FALLBACK_BODY = 'Voice message';

type AudioFormat = 'webm' | 'ogg' | 'mp4' | 'mp3' | 'wav' | 'aac';

/** Normalised MIME type (parameters such as `;codecs=opus` stripped) → container format. */
const MIME_TO_FORMAT: Record<string, AudioFormat> = {
  'audio/webm': 'webm',
  'video/webm': 'webm', // some browsers label an audio-only WebM recording video/webm
  'audio/ogg': 'ogg',
  'audio/mp4': 'mp4',
  'audio/x-m4a': 'mp4',
  'audio/m4a': 'mp4',
  'audio/aac': 'aac',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
};

const FORMAT_EXTENSION: Record<AudioFormat, string> = {
  webm: 'webm',
  ogg: 'ogg',
  mp4: 'm4a',
  mp3: 'mp3',
  wav: 'wav',
  aac: 'aac',
};

/** The content type the object is stored (and later served) with. */
const FORMAT_CONTENT_TYPE: Record<AudioFormat, string> = {
  webm: 'audio/webm',
  ogg: 'audio/ogg',
  mp4: 'audio/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  aac: 'audio/aac',
};

function sniffFormat(buf: Buffer): AudioFormat | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm';
  if (buf.toString('latin1', 0, 4) === 'OggS') return 'ogg';
  if (buf.toString('latin1', 4, 8) === 'ftyp') return 'mp4';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WAVE')
    return 'wav';
  if (buf.toString('latin1', 0, 3) === 'ID3') return 'mp3';
  // MPEG audio frame sync (11 set bits): layer bits 01/10/11 → MP3, layer 00 → ADTS AAC.
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return (buf[1] & 0x06) === 0 ? 'aac' : 'mp3';
  return null;
}

export interface ValidatedAudio {
  contentType: string;
  extension: string;
}

/**
 * The stored content type + file extension for an upload whose declared MIME type is an allowed
 * audio type AND matches its magic bytes; `null` otherwise.
 */
export function validateAudio(buffer: Buffer, declaredMime: string): ValidatedAudio | null {
  const declared = MIME_TO_FORMAT[(declaredMime ?? '').split(';')[0].trim().toLowerCase()];
  if (!declared) return null;
  const sniffed = sniffFormat(buffer);
  if (!sniffed) return null;
  // WebM is a Matroska profile and AAC/MP3 share the frame sync — compare by container only.
  const sameFamily =
    sniffed === declared || (['mp3', 'aac'].includes(sniffed) && ['mp3', 'aac'].includes(declared));
  if (!sameFamily) return null;
  return { contentType: FORMAT_CONTENT_TYPE[declared], extension: FORMAT_EXTENSION[declared] };
}
