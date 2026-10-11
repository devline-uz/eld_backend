import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import type { ContextUser } from '../../core/context/request-context';
import { STORAGE_PORT, StoragePort } from '../../core/storage/storage.port';
import { ATTACHMENT_PRESIGN_TTL_SEC } from './attachments.service';
import { AttachmentsRepository } from './attachments.repository';

/** MB-9 — one chat file is at most 10 MiB (decoded bytes). */
export const MAX_CHAT_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const CHAT_ATTACHMENT_KINDS = ['CHAT_AUDIO', 'CHAT_FILE'] as const;
export type ChatAttachmentKind = (typeof CHAT_ATTACHMENT_KINDS)[number];
export type MessageType = 'TEXT' | 'AUDIO' | 'IMAGE' | 'FILE';

/** Mime types a client may declare, grouped by the format the magic bytes must prove. */
const DECLARED: Record<string, 'aac' | 'm4a' | 'png' | 'jpeg' | 'pdf'> = {
  'audio/aac': 'aac',
  'audio/x-aac': 'aac',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'application/pdf': 'pdf',
};
const FORMATS = {
  aac: { mime: 'audio/aac', ext: 'aac', kind: 'CHAT_AUDIO' },
  m4a: { mime: 'audio/mp4', ext: 'm4a', kind: 'CHAT_AUDIO' },
  png: { mime: 'image/png', ext: 'png', kind: 'CHAT_FILE' },
  jpeg: { mime: 'image/jpeg', ext: 'jpg', kind: 'CHAT_FILE' },
  pdf: { mime: 'application/pdf', ext: 'pdf', kind: 'CHAT_FILE' },
} as const;
type Format = keyof typeof FORMATS;

/** Identifies a chat file by its leading bytes; the client-declared mime is never trusted. */
export function sniffChatFormat(b: Buffer): Format | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (b.length >= 12 && b.subarray(4, 8).toString('latin1') === 'ftyp') return 'm4a';
  // ADTS AAC: 12-bit syncword 0xFFF, layer bits (b1 & 0x06) == 0.
  if (b.length >= 7 && b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return 'aac';
  return null;
}

export interface ChatAttachmentView {
  id: string;
  url: string;
  mimeType: string;
  sizeBytes: number;
  durationSec: number | null;
}

export function messageTypeOf(att: { kind: string | null; mimeType: string } | null | undefined): MessageType {
  if (!att) return 'TEXT';
  if (att.kind === 'CHAT_AUDIO') return 'AUDIO';
  return att.mimeType.startsWith('image/') ? 'IMAGE' : 'FILE';
}

/**
 * MB-9 — chat voice/file attachments: validated storage (magic bytes, <= 10 MiB, keys under
 * `chat/carrier/{uploader}/`), send-time ownership check, and the `type` + `attachment{}` view
 * every message list/send/realtime payload carries. Presign authorization lives in
 * `AttachmentsService.mayView` (conversation participants only).
 */
@Injectable()
export class ChatAttachmentsService {
  constructor(
    private readonly repo: AttachmentsRepository,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
  ) {}

  async store(input: { buffer: Buffer; mimeType: string; kind: ChatAttachmentKind; durationSec?: number | null; uploader: ContextUser }) {
    const { buffer, kind, uploader } = input;
    if (buffer.length === 0) throw new AppException(ERROR_CODES.VALIDATION_FAILED, 'The file is empty.', 422);
    if (buffer.length > MAX_CHAT_ATTACHMENT_BYTES) {
      throw new AppException(ERROR_CODES.FILE_TOO_LARGE, 'Chat attachment exceeds the 10 MB limit.', 413, { maxBytes: MAX_CHAT_ATTACHMENT_BYTES });
    }
    const declared = DECLARED[input.mimeType.toLowerCase()];
    const actual = sniffChatFormat(buffer);
    if (!declared || !actual || FORMATS[actual].kind !== kind || declared !== actual) {
      throw new AppException(
        ERROR_CODES.UNSUPPORTED_FILE_TYPE,
        kind === 'CHAT_AUDIO' ? 'Voice message must be AAC or M4A audio.' : 'Chat file must be a PNG, JPEG or PDF.',
        422,
        { mimeType: 'Declared type does not match the file content.' },
      );
    }
    const fmt = FORMATS[actual];
    const id = randomUUID();
    const key = `chat/carrier/${uploader.id}/${id}.${fmt.ext}`;
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    await this.storage.put(key, buffer, { contentType: fmt.mime, contentLength: buffer.length });
    const durationSec = kind === 'CHAT_AUDIO' ? (input.durationSec ?? null) : null;
    await this.repo.createChat({
      id,
      key,
      mimeType: fmt.mime,
      sizeBytes: buffer.length,
      sha256,
      kind,
      durationSec,
      uploadedById: uploader.id,
      uploadedByType: uploader.type === 'driver' ? 'DRIVER' : 'USER',
    });
    return { id, attachmentId: id, key, mimeType: fmt.mime, sizeBytes: buffer.length, sha256, durationSec, kind };
  }

  /** The caller may attach only their own, not yet used chat upload. */
  async assertSendable(attachmentId: string, actor: ContextUser): Promise<void> {
    const row = await this.repo.findChatForSend(attachmentId);
    const ownerType = actor.type === 'driver' ? 'DRIVER' : 'USER';
    if (!row || row.uploadedById !== actor.id || row.uploadedByType !== ownerType) {
      throw new AppException(ERROR_CODES.ATTACHMENT_NOT_FOUND, 'Attachment not found.', 404, { id: attachmentId });
    }
    if (row.messageId) {
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, 'Attachment is already used by another message.', 422, { attachmentId: 'Already attached.' });
    }
  }

  /** Adds `type` + `attachment{}` to each message with one batched lookup (no N+1). */
  async decorate<T extends { attachmentId: string | null }>(
    messages: T[],
  ): Promise<Array<T & { type: MessageType; attachment: ChatAttachmentView | null }>> {
    const ids = [...new Set(messages.map((m) => m.attachmentId).filter((x): x is string => !!x))];
    const rows = ids.length ? await this.repo.findChatByIds(ids) : [];
    const views = new Map<string, { type: MessageType; view: ChatAttachmentView }>();
    await Promise.all(
      rows.map(async (r) => {
        const url = await this.storage.presignGet(r.key, ATTACHMENT_PRESIGN_TTL_SEC);
        views.set(r.id, { type: messageTypeOf(r), view: { id: r.id, url, mimeType: r.mimeType, sizeBytes: r.sizeBytes, durationSec: r.durationSec } });
      }),
    );
    return messages.map((m) => {
      const v = m.attachmentId ? views.get(m.attachmentId) : undefined;
      return { ...m, type: v?.type ?? 'TEXT', attachment: v?.view ?? null };
    });
  }
}
