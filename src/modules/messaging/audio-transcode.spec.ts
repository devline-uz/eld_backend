import { spawnSync } from 'node:child_process';
import { needsTranscode, transcodeToM4a } from './audio-transcode';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const maybe = hasFfmpeg ? it : it.skip;

describe('audio-transcode', () => {
  it('only webm/ogg need transcoding', () => {
    expect(needsTranscode('webm')).toBe(true);
    expect(needsTranscode('ogg')).toBe(true);
    expect(needsTranscode('m4a')).toBe(false);
  });

  maybe('converts a real WebM/Opus clip to an MP4 (ftyp) container', async () => {
    const gen = spawnSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libopus', '-f', 'webm', 'pipe:1'], { maxBuffer: 5_000_000 });
    expect(gen.status).toBe(0);
    const out = await transcodeToM4a(gen.stdout, 'webm');
    expect(out.contentType).toBe('audio/mp4');
    expect(out.extension).toBe('m4a');
    expect(out.buffer.subarray(4, 8).toString('latin1')).toBe('ftyp');
  });

  it('rejects when the binary is missing', async () => {
    await expect(transcodeToM4a(Buffer.from('x'), 'webm', { bin: '/nonexistent/ffmpeg' })).rejects.toThrow();
  });

  maybe('rejects on garbage input (ffmpeg non-zero exit)', async () => {
    await expect(transcodeToM4a(Buffer.from('not audio at all'), 'webm')).rejects.toThrow(/ffmpeg exited/);
  });
});
