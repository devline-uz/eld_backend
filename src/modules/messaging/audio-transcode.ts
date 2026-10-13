import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Containers the web recorder produces that Safari/mobile cannot all play — converted to AAC/M4A. */
const TRANSCODE_INPUT_EXT = new Set(['webm', 'ogg']);
export const TRANSCODE_TIMEOUT_MS = 30_000;

export interface TranscodedAudio {
  buffer: Buffer;
  contentType: 'audio/mp4';
  extension: 'm4a';
}

export function needsTranscode(extension: string): boolean {
  return TRANSCODE_INPUT_EXT.has(extension);
}

/** ffmpeg binary: `FFMPEG_PATH` env, default `ffmpeg` (resolved through PATH). */
export function ffmpegPath(): string {
  return process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
}

/**
 * WebM/Ogg (Opus) -> AAC in an MP4 container with `+faststart`. Uses temp files (the mp4 muxer needs
 * a seekable output), an argument array (no shell) and a hard timeout. Rejects on any failure; the
 * caller keeps the original file.
 */
export async function transcodeToM4a(
  input: Buffer,
  inputExtension: string,
  opts: { timeoutMs?: number; bin?: string } = {},
): Promise<TranscodedAudio> {
  const dir = await mkdtemp(join(tmpdir(), 'voice-'));
  try {
    const inPath = join(dir, `${randomUUID()}.${inputExtension}`);
    const outPath = join(dir, `${randomUUID()}.m4a`);
    await writeFile(inPath, input);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        opts.bin ?? ffmpegPath(),
        ['-nostdin', '-y', '-loglevel', 'error', '-i', inPath, '-vn', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', '-f', 'mp4', outPath],
        { stdio: ['ignore', 'ignore', 'pipe'], shell: false },
      );
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => {
        if (stderr.length < 2000) stderr += d.toString();
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`ffmpeg timed out after ${opts.timeoutMs ?? TRANSCODE_TIMEOUT_MS} ms`));
      }, opts.timeoutMs ?? TRANSCODE_TIMEOUT_MS);
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim()}`));
      });
    });
    const buffer = await readFile(outPath);
    if (buffer.length === 0) throw new Error('ffmpeg produced an empty file');
    return { buffer, contentType: 'audio/mp4', extension: 'm4a' };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
