import { MessagingService } from './messaging.service';

function buildService(conversation: unknown = { id: 'cnv_1' }, isParticipant = true) {
  const repo = {
    findById: jest.fn(async (_id?: string): Promise<unknown> => conversation),
    isParticipant: jest.fn(async () => isParticipant),
    markRead: jest.fn(async () => undefined),
    listForActor: jest.fn(async () => []),
    createMessage: jest.fn(async (conversationId: string, data: Record<string, unknown>) => ({
      id: 'msg_1',
      conversationId,
      body: data.body,
      attachmentId: data.attachmentId ?? null,
      clientId: data.clientId ?? null,
      senderUserId: data.senderUserId ?? null,
      senderDriverId: data.senderDriverId ?? null,
      sentAt: new Date('2026-10-11T10:00:00Z'),
    })),
    findUserDisplayName: jest.fn(async () => 'Ann Dispatcher'),
    createConversation: jest.fn(async (data: Record<string, unknown>, participants: Array<{ userId?: string; driverId?: string }> = []) => ({
      id: 'cnv_new',
      type: 'DIRECT',
      title: null,
      ...data,
      participants: participants.map((p) => ({ userId: p.userId ?? null, driverId: p.driverId ?? null })),
    })),
    findLiveDriverIds: jest.fn(async (ids: string[]) => new Set(ids)),
    findUserIds: jest.fn(async (ids: string[]) => new Set(ids)),
    findDirectBetween: jest.fn(async (..._args: unknown[]): Promise<unknown> => null),
  };
  const chat = { decorate: jest.fn(async (ms: Array<Record<string, unknown>>) => ms.map((m) => ({ ...m, type: 'TEXT', attachment: null }))), assertSendable: jest.fn(async () => undefined) };
  const push = { sendToDriver: jest.fn(async () => undefined) };
  const events = { publish: jest.fn(async (_name: string, _payload: unknown) => undefined) };
  const service = new MessagingService(repo as never, events as never, push as never, chat as never);
  return { service, repo, push, events, chat };
}

const conversationWithParticipants = {
  id: 'cnv_1',
  participants: [
    { userId: 'usr_1', driverId: null },
    { userId: null, driverId: 'drv_1' },
  ],
};

const actor = { id: 'usr_1', type: 'user' } as never;

describe('MessagingService — §20 B-67 mark read', () => {
  it('marks the caller participant read and returns the timestamp', async () => {
    const { service, repo } = buildService();
    const result = await service.markRead('cnv_1', actor);
    expect(repo.markRead).toHaveBeenCalledWith('cnv_1', { userId: 'usr_1' }, expect.any(Date));
    expect(result.conversationId).toBe('cnv_1');
    expect(result.lastReadAt).toBeInstanceOf(Date);
  });

  it('404s for a conversation that does not exist', async () => {
    const { service } = buildService(null);
    await expect(service.markRead('cnv_x', actor)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('403s for a real conversation the caller is not a participant of', async () => {
    const { service } = buildService({ id: 'cnv_1' }, false);
    await expect(service.markRead('cnv_1', actor)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('MessagingService — realtime chat contract', () => {
  it('message.new goes to the conversation room AND every staff identity room in one push (no driver rooms)', async () => {
    const { service, events } = buildService(conversationWithParticipants);
    await service.sendMessage('cnv_1', { body: 'hello', clientId: 'c1' }, actor);
    expect(events.publish).toHaveBeenCalledTimes(1);
    expect(events.publish).toHaveBeenCalledWith('realtime.push', {
      room: ['conversation:cnv_1', 'user:usr_1'],
      event: 'message.new',
      payload: {
        conversationId: 'cnv_1',
        message: expect.objectContaining({ id: 'msg_1', conversationId: 'cnv_1', senderUserId: 'usr_1', senderId: 'usr_1', senderType: 'STAFF' }) as unknown,
      },
    });
  });

  it('a driver-sent message.new carries senderType DRIVER and reaches the staff identity room', async () => {
    const { service, events } = buildService(conversationWithParticipants);
    await service.sendMessage('cnv_1', { body: 'from cab' }, { id: 'drv_1', type: 'driver' } as never);
    const [, push] = events.publish.mock.calls[0] as [string, { room: string[]; payload: { message: Record<string, unknown> } }];
    expect(push.room).toContain('user:usr_1');
    expect(push.payload.message).toMatchObject({ senderDriverId: 'drv_1', senderId: 'drv_1', senderType: 'DRIVER' });
  });

  it('dedupes identity rooms when a participant appears twice', async () => {
    const { service, events } = buildService({
      id: 'cnv_1',
      participants: [
        { userId: 'usr_1', driverId: null },
        { userId: 'usr_1', driverId: null },
      ],
    });
    await service.sendMessage('cnv_1', { body: 'x' }, actor);
    const [, push] = events.publish.mock.calls[0] as [string, { room: string[] }];
    expect(push.room).toEqual(['conversation:cnv_1', 'user:usr_1']);
  });

  it('createConversation pushes conversation.new to every staff identity room (creator included, no driver rooms)', async () => {
    const { service, events } = buildService();
    const out = await service.createConversation({ type: 'GROUP', driverIds: ['drv_1'], userIds: ['usr_2'] } as never, actor);
    expect(out.id).toBe('cnv_new');
    expect(events.publish).toHaveBeenCalledWith('realtime.push', {
      room: ['user:usr_1', 'user:usr_2'],
      event: 'conversation.new',
      payload: expect.objectContaining({ conversationId: 'cnv_new', message: null }) as unknown,
    });
  });

  it('a conversation.new push failure never fails createConversation', async () => {
    const { service, events } = buildService();
    events.publish.mockRejectedValueOnce(new Error('redis down'));
    await expect(service.createConversation({ type: 'DIRECT', driverIds: ['drv_1'], userIds: [] } as never, actor)).resolves.toMatchObject({ id: 'cnv_new' });
  });

  it('markRead pushes conversation.read to the reader identity room only', async () => {
    const { service, events } = buildService();
    await service.markRead('cnv_1', actor);
    expect(events.publish).toHaveBeenCalledWith('realtime.push', {
      room: 'user:usr_1',
      event: 'conversation.read',
      payload: { conversationId: 'cnv_1', lastReadAt: expect.any(Date) as Date, userId: 'usr_1' },
    });
  });

  it('a driver mark-read pushes nothing', async () => {
    const { service, events } = buildService();
    await service.markRead('cnv_1', { id: 'drv_1', type: 'driver' } as never);
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('notifyConversationStarted (MR-3) pushes conversation.new to the staff user room', async () => {
    const { service, events } = buildService();
    await service.notifyConversationStarted('usr_1', 'cnv_9', { id: 'msg_9' });
    expect(events.publish).toHaveBeenCalledWith('realtime.push', {
      room: 'user:usr_1',
      event: 'conversation.new',
      payload: { conversationId: 'cnv_9', message: { id: 'msg_9' } },
    });
  });

  it('broadcast emits message.new and conversation.new to staff rooms for each driver thread', async () => {
    const { service, repo, events } = buildService();
    repo.findById.mockImplementation(async () => ({ id: 'cnv_new', participants: [{ userId: 'usr_1', driverId: null }, { userId: null, driverId: 'drv_9' }] }));
    await service.broadcast({ driverIds: ['drv_9'], body: 'all hands', title: 'Notice' }, actor);
    const pushes = events.publish.mock.calls.map(([, p]) => p as { event: string; room: string | string[] });
    expect(pushes.map((p) => p.event)).toEqual(['conversation.new', 'message.new', 'conversation.new']);
    expect(pushes[0].room).toBe('driver:drv_9');
    expect(pushes[1].room).toEqual(['conversation:cnv_new', 'user:usr_1']);
    expect(pushes[2].room).toEqual(['user:usr_1']);
  });
});

describe('MessagingService — web conversation validation (BE-010 / BE-012)', () => {
  it('DIRECT with an existing 1:1 thread returns it instead of creating a duplicate', async () => {
    const { service, repo, events } = buildService();
    const existing = { id: 'cnv_old', type: 'DIRECT', participants: [{ userId: 'usr_1' }, { driverId: 'drv_1' }] };
    repo.findDirectBetween.mockResolvedValueOnce(existing);
    await expect(service.createConversation({ type: 'DIRECT', driverIds: ['drv_1'], userIds: [] }, actor)).resolves.toBe(existing);
    expect(repo.findDirectBetween).toHaveBeenCalledWith({ userId: 'usr_1' }, { driverId: 'drv_1' });
    expect(repo.createConversation).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('DIRECT needs exactly one other participant (duplicates and the creator do not count)', async () => {
    const { service, repo } = buildService();
    await expect(service.createConversation({ type: 'DIRECT', driverIds: ['drv_1', 'drv_2'], userIds: [] }, actor)).rejects.toMatchObject({ status: 422 });
    await expect(service.createConversation({ type: 'DIRECT', driverIds: [], userIds: ['usr_1'] }, actor)).rejects.toMatchObject({ status: 422 });
    await service.createConversation({ type: 'DIRECT', driverIds: ['drv_1', 'drv_1'], userIds: ['usr_1'] }, actor);
    expect(repo.createConversation).toHaveBeenCalledWith(expect.anything(), [{ userId: 'usr_1' }, { driverId: 'drv_1' }]);
  });

  it('GROUP with no participants besides the creator is a 422', async () => {
    const { service, repo } = buildService();
    await expect(service.createConversation({ type: 'GROUP', driverIds: [], userIds: [] }, actor)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
    });
    expect(repo.createConversation).not.toHaveBeenCalled();
  });

  it('unknown / deleted drivers and unknown users are a 422 listing them, not an FK 500', async () => {
    const { service, repo } = buildService();
    repo.findLiveDriverIds.mockResolvedValueOnce(new Set(['drv_1']));
    repo.findUserIds.mockResolvedValueOnce(new Set());
    await expect(service.createConversation({ type: 'GROUP', driverIds: ['drv_1', 'drv_gone'], userIds: ['usr_x'] }, actor)).rejects.toMatchObject({
      status: 422,
      details: { driverIds: ['drv_gone'], userIds: ['usr_x'] },
    });
    expect(repo.createConversation).not.toHaveBeenCalled();
  });

  it('broadcast validates every driver up front and sends nothing when one is unknown', async () => {
    const { service, repo } = buildService(conversationWithParticipants);
    repo.findLiveDriverIds.mockResolvedValueOnce(new Set(['drv_1']));
    await expect(service.broadcast({ driverIds: ['drv_1', 'drv_gone'], body: 'hi' }, actor)).rejects.toMatchObject({
      status: 422,
      details: { driverIds: ['drv_gone'] },
    });
    expect(repo.createConversation).not.toHaveBeenCalled();
  });

  it('broadcast de-duplicates recipients', async () => {
    const { service, repo } = buildService(conversationWithParticipants);
    const out = await service.broadcast({ driverIds: ['drv_1', 'drv_1'], body: 'hi' }, actor);
    expect(out.sent).toBe(1);
    expect(repo.createConversation).toHaveBeenCalledTimes(1);
  });
});
