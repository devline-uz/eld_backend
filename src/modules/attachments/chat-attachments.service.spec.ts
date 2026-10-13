import { ChatAttachmentsService, messageTypeOf, sniffChatFormat } from './chat-attachments.service';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const PDF = Buffer.from('%PDF-1.4\nbody');
const M4A = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(16)]);
const AAC = Buffer.concat([Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x02, 0x1f, 0xfc]), Buffer.alloc(16)]);
const driver = { id: 'drv_1', type: 'driver' } as never;

function build() {
  const repo = {
    createChat: jest.fn(async () => ({})),
    findChatForSend: jest.fn(),
    findChatByIds: jest.fn(async () => []),
  };
  const storage = { put: jest.fn(async (k: string) => k), presignGet: jest.fn(async (k: string) => `https://s/${k}`) };
  return { repo, storage, service: new ChatAttachmentsService(repo as never, storage as never) };
}

describe('sniffChatFormat', () => {
  it('recognises each allowed format by magic bytes', () => {
    expect(sniffChatFormat(PNG)).toBe('png');
    expect(sniffChatFormat(JPEG)).toBe('jpeg');
    expect(sniffChatFormat(PDF)).toBe('pdf');
    expect(sniffChatFormat(M4A)).toBe('m4a');
    expect(sniffChatFormat(AAC)).toBe('aac');
    expect(sniffChatFormat(Buffer.from('<html>hello world</html>'))).toBeNull();
  });
});

describe('ChatAttachmentsService.store', () => {
  it('stores an m4a voice note under chat/carrier/{uploader}/ and records it', async () => {
    const { service, repo, storage } = build();
    const r = await service.store({ buffer: M4A, mimeType: 'audio/x-m4a', kind: 'CHAT_AUDIO', durationSec: 7, uploader: driver });
    expect(r.key).toMatch(/^chat\/carrier\/drv_1\/[0-9a-f-]+\.m4a$/);
    expect(r.mimeType).toBe('audio/mp4');
    expect(storage.put).toHaveBeenCalled();
    expect(repo.createChat).toHaveBeenCalledWith(expect.objectContaining({ kind: 'CHAT_AUDIO', durationSec: 7, uploadedByType: 'DRIVER' }));
  });

  it('rejects declared type that does not match the bytes (html posing as png)', async () => {
    const { service } = build();
    await expect(service.store({ buffer: Buffer.from('<script>alert(1)</script>'), mimeType: 'image/png', kind: 'CHAT_FILE', uploader: driver }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_FILE_TYPE' });
  });

  it('rejects audio bytes for CHAT_FILE and a PDF for CHAT_AUDIO', async () => {
    const { service } = build();
    await expect(service.store({ buffer: AAC, mimeType: 'audio/aac', kind: 'CHAT_FILE', uploader: driver })).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE_TYPE' });
    await expect(service.store({ buffer: PDF, mimeType: 'application/pdf', kind: 'CHAT_AUDIO', uploader: driver })).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE_TYPE' });
  });

  it('rejects files above 10 MB with FILE_TOO_LARGE and empty files', async () => {
    const { service } = build();
    const big = Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]);
    await expect(service.store({ buffer: big, mimeType: 'application/pdf', kind: 'CHAT_FILE', uploader: driver })).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    await expect(service.store({ buffer: Buffer.alloc(0), mimeType: 'application/pdf', kind: 'CHAT_FILE', uploader: driver })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('ChatAttachmentsService.assertSendable / decorate', () => {
  it('only the uploader may attach, and only once', async () => {
    const { service, repo } = build();
    repo.findChatForSend.mockResolvedValueOnce({ id: 'a', uploadedById: 'drv_2', uploadedByType: 'DRIVER', messageId: null });
    await expect(service.assertSendable('a', driver)).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
    repo.findChatForSend.mockResolvedValueOnce({ id: 'a', uploadedById: 'drv_1', uploadedByType: 'DRIVER', messageId: 'm1' });
    await expect(service.assertSendable('a', driver)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    repo.findChatForSend.mockResolvedValueOnce({ id: 'a', uploadedById: 'drv_1', uploadedByType: 'DRIVER', messageId: null });
    await expect(service.assertSendable('a', driver)).resolves.toBeUndefined();
  });

  it('decorates with one batched lookup and derives type', async () => {
    const { service, repo } = build();
    repo.findChatByIds.mockResolvedValue([
      { id: 'a1', key: 'chat/x/a1.m4a', kind: 'CHAT_AUDIO', mimeType: 'audio/mp4', sizeBytes: 5, durationSec: 3 },
      { id: 'a2', key: 'chat/x/a2.png', kind: 'CHAT_FILE', mimeType: 'image/png', sizeBytes: 9, durationSec: null },
    ] as never);
    const out = await service.decorate([
      { id: 'm1', attachmentId: 'a1' }, { id: 'm2', attachmentId: 'a2' }, { id: 'm3', attachmentId: null },
    ]);
    expect(repo.findChatByIds).toHaveBeenCalledTimes(1);
    expect(out.map((m) => m.type)).toEqual(['AUDIO', 'IMAGE', 'TEXT']);
    expect(out[0].attachment).toMatchObject({ id: 'a1', url: 'https://s/chat/x/a1.m4a', durationSec: 3 });
    expect(out[2].attachment).toBeNull();
    expect(messageTypeOf({ kind: 'CHAT_FILE', mimeType: 'application/pdf' })).toBe('FILE');
  });

  it('web MESSAGE_AUDIO clip -> AUDIO with presigned url and whole-second durationSec; stored AUDIO is never downgraded', async () => {
    const { service, repo } = build();
    repo.findChatByIds.mockResolvedValue([
      { id: 'w1', key: 'messages/c/w1.webm', kind: 'MESSAGE_AUDIO', mimeType: 'audio/webm', sizeBytes: 51519, durationSec: null, durationMs: 3335 },
    ] as never);
    const out = await service.decorate([
      { id: 'm1', attachmentId: 'w1', type: 'TEXT' },
      { id: 'm2', attachmentId: 'gone', type: 'AUDIO' },
    ]);
    expect(out[0].type).toBe('AUDIO');
    expect(out[0].attachment).toEqual({ id: 'w1', url: 'https://s/messages/c/w1.webm', mimeType: 'audio/webm', sizeBytes: 51519, durationSec: 3 });
    expect(out[1]).toMatchObject({ type: 'AUDIO', attachment: null });
    expect(messageTypeOf({ kind: 'MESSAGE_AUDIO', mimeType: 'audio/mp4' })).toBe('AUDIO');
  });
});
