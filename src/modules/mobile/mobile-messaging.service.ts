import { Injectable } from '@nestjs/common';
import type { Message, Prisma } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import type { ContextUser } from '../../core/context/request-context';
import { MessagingRepository } from '../messaging/messaging.repository';
import { MessagingService } from '../messaging/messaging.service';
import type { ListMessagesQueryDto, MobileSendMessageDto, StartConversationDto } from './dto/mobile-messaging.dto';
import { ConversationSummary, MobileMessagingRepository } from './mobile-messaging.repository';
import { MobileRepository } from './mobile.repository';

export type MobileSenderType = 'DRIVER' | 'STAFF' | 'SYSTEM';

/** MR-18 — the message shape the app reads. Additive over the raw row (all old fields kept). */
export type MobileMessage = Message & {
  senderId: string | null;
  senderType: MobileSenderType;
  senderName: string | null;
};

export interface MobileParticipant {
  id: string;
  type: 'DRIVER' | 'STAFF';
  name: string | null;
}

export interface StartConversationResult {
  conversationId: string;
  message: { id: string; body: string; sentAt: Date; senderId: string; senderType: 'DRIVER'; clientId: string | null };
}

type NameMaps = { users: Map<string, string>; drivers: Map<string, string> };

export function toMobileMessage(m: Message, names: NameMaps): MobileMessage {
  if (m.senderDriverId) {
    return { ...m, senderId: m.senderDriverId, senderType: 'DRIVER', senderName: names.drivers.get(m.senderDriverId) ?? null };
  }
  if (m.senderUserId) {
    return { ...m, senderId: m.senderUserId, senderType: 'STAFF', senderName: names.users.get(m.senderUserId) ?? null };
  }
  return { ...m, senderId: null, senderType: 'SYSTEM', senderName: null };
}

/**
 * TZ §11.5 / mobile.tz §7.5 (screen S-14) — MB-15. Thin driver-facing layer over the existing
 * `MessagingService`/`MessagingRepository` (never `messaging.controller.ts`, which stays
 * untouched): conversation list gets a last-message + unread-count summary the web contract
 * does not need, message listing is cursor-based instead of offset-paged, and sending/reading
 * reuse the shared service/repository outright so the `message.new` realtime push and the
 * participant check are never duplicated.
 */
@Injectable()
export class MobileMessagingService {
  constructor(
    private readonly repo: MobileMessagingRepository,
    private readonly messagingRepo: MessagingRepository,
    private readonly messaging: MessagingService,
    private readonly mobileRepo: MobileRepository,
  ) {}

  /** MR-18 — each row gains `participants[]` and a non-null `title` (the other party's name for
   *  DIRECT chats, "Support" for SUPPORT) plus an enriched `lastMessage`. */
  async listConversations(driverId: string) {
    const rows = await this.repo.listForDriver(driverId);
    const userIds = new Set<string>();
    const driverIds = new Set<string>();
    for (const r of rows) {
      for (const p of r.rawParticipants) {
        if (p.userId) userIds.add(p.userId);
        if (p.driverId) driverIds.add(p.driverId);
      }
      if (r.lastMessage?.senderUserId) userIds.add(r.lastMessage.senderUserId);
      if (r.lastMessage?.senderDriverId) driverIds.add(r.lastMessage.senderDriverId);
    }
    const names = await this.repo.nameMaps([...userIds], [...driverIds]);
    const items = rows.map(({ rawParticipants, ...row }) => {
      const participants = this.toParticipants(rawParticipants, names);
      return {
        ...row,
        title: this.conversationTitle(row, participants, driverId),
        participants,
        lastMessage: row.lastMessage ? toMobileMessage(row.lastMessage, names) : null,
      };
    });
    return { items };
  }

  private toParticipants(raw: ConversationSummary['rawParticipants'], names: NameMaps): MobileParticipant[] {
    return raw.flatMap((p): MobileParticipant[] => {
      if (p.driverId) return [{ id: p.driverId, type: 'DRIVER', name: names.drivers.get(p.driverId) ?? null }];
      if (p.userId) return [{ id: p.userId, type: 'STAFF', name: names.users.get(p.userId) ?? null }];
      return [];
    });
  }

  private conversationTitle(row: { type: string; title: string | null }, participants: MobileParticipant[], driverId: string): string | null {
    if (row.title) return row.title;
    if (row.type === 'SUPPORT') return 'Support';
    const others = participants.filter((p) => p.id !== driverId).map((p) => p.name).filter((n): n is string => Boolean(n));
    return others.length ? others.join(', ') : null;
  }

  private async enrich(messages: Message[]): Promise<MobileMessage[]> {
    const names = await this.repo.nameMaps(
      [...new Set(messages.map((m) => m.senderUserId).filter((x): x is string => Boolean(x)))],
      [...new Set(messages.map((m) => m.senderDriverId).filter((x): x is string => Boolean(x)))],
    );
    return messages.map((m) => toMobileMessage(m, names));
  }

  async listMessages(conversationId: string, driverId: string, query: ListMessagesQueryDto) {
    await this.assertParticipant(conversationId, driverId);
    const items = await this.repo.listMessagesCursor(conversationId, query.limit, query.before);
    return { items: await this.enrich(items), limit: query.limit };
  }

  async sendMessage(conversationId: string, dto: MobileSendMessageDto, actor: ContextUser) {
    // MR-18 — replay of an already-delivered `clientId` returns the stored message (no 500 on
    // the unique `Message.clientId`, no duplicate row, no second realtime push).
    if (dto.clientId) {
      const prior = await this.repo.findMessageByClientId(dto.clientId);
      if (prior) {
        if (prior.senderDriverId !== actor.id || prior.conversationId !== conversationId) {
          throw AppException.conflict('clientId already used by another message.', { clientId: dto.clientId });
        }
        return (await this.enrich([prior]))[0];
      }
    }
    // `MessagingService.sendMessage` re-checks participation itself (403), creates the
    // message and publishes `realtime.push` / `message.new` — reused verbatim.
    const message = await this.messaging.sendMessage(conversationId, dto, actor);
    return (await this.enrich([message]))[0];
  }

  /**
   * MR-3 — `POST /mobile/conversations`. Opens (or reuses) the DIRECT conversation with a staff
   * contact / the active co-driver, or the driver's SUPPORT conversation for `contactId:"support"`,
   * and sends the first message. Idempotent on `clientId` via the `SyncedChange` ledger.
   */
  async startConversation(driverId: string, dto: StartConversationDto, actor: ContextUser): Promise<StartConversationResult> {
    const ledgerType = 'create_conversation';
    const prior = await this.mobileRepo.findSyncedByClientId(driverId, dto.clientId);
    // Shared ledger: never answer with another operation's stored result (e.g. a release_vehicle).
    if (prior && prior.type !== ledgerType) {
      throw AppException.conflict('clientId already used by another operation.', { clientId: dto.clientId });
    }
    if (prior?.status === 'ACCEPTED' && prior.result) return prior.result as unknown as StartConversationResult;

    let conversationId: string;
    let notifyUserId: string | null = null;
    if (dto.contactId === 'support') {
      const existing = await this.repo.findSupportConversation(driverId);
      conversationId =
        existing?.id ??
        (await this.messagingRepo.createConversation({ type: 'SUPPORT', title: 'Support', createdById: driverId }, [{ driverId }])).id;
    } else {
      const staff = await this.repo.findActiveStaff(dto.contactId);
      let other: { userId?: string; driverId?: string };
      if (staff) {
        other = { userId: staff.id };
        notifyUserId = staff.id;
      } else {
        const pairing = await this.mobileRepo.findActivePairing(driverId);
        const coDriverId = pairing ? (pairing.primaryDriverId === driverId ? pairing.coDriverId : pairing.primaryDriverId) : null;
        if (!coDriverId || coDriverId !== dto.contactId) {
          throw new AppException(ERROR_CODES.NOT_FOUND, 'Contact not found.', 404, { contactId: dto.contactId });
        }
        other = { driverId: coDriverId };
      }
      const existing = await this.repo.findDirectConversation(driverId, other);
      conversationId =
        existing?.id ??
        (await this.messagingRepo.createConversation({ type: 'DIRECT', createdById: driverId }, [{ driverId }, other])).id;
    }

    const sent = await this.sendMessage(conversationId, { body: dto.body, clientId: dto.clientId }, actor);
    if (notifyUserId) {
      // Lets an open admin panel add the new thread without polling (same bus as `message.new`).
      await this.messaging.notifyConversationStarted(notifyUserId, conversationId, sent).catch(() => undefined);
    }
    const result = {
      conversationId,
      message: {
        id: sent.id,
        body: sent.body,
        sentAt: sent.sentAt,
        senderId: driverId,
        senderType: 'DRIVER' as const,
        clientId: sent.clientId,
      },
    };
    await this.mobileRepo.recordSyncedResult(driverId, dto.clientId, ledgerType, new Date(), 'ACCEPTED', null, JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue);
    return result;
  }

  async markRead(conversationId: string, driverId: string, now: Date = new Date()) {
    await this.assertParticipant(conversationId, driverId);
    return this.repo.markRead(conversationId, driverId, now);
  }

  private async assertParticipant(conversationId: string, driverId: string): Promise<void> {
    const conversation = await this.messagingRepo.findById(conversationId);
    if (!conversation) throw new AppException(ERROR_CODES.NOT_FOUND, 'Conversation not found.', 404);
    const ok = await this.messagingRepo.isParticipant(conversationId, { driverId });
    if (!ok) throw new AppException(ERROR_CODES.FORBIDDEN, 'Not a participant of this conversation.', 403);
  }
}
