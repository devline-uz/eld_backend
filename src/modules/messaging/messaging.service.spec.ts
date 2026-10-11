import { MessagingService } from './messaging.service';

function buildService(conversation: unknown = { id: 'cnv_1' }, isParticipant = true) {
  const repo = {
    findById: jest.fn(async () => conversation),
    isParticipant: jest.fn(async () => isParticipant),
    markRead: jest.fn(async () => undefined),
    listForActor: jest.fn(async () => []),
    createMessage: jest.fn(async (conversationId: string, d: { body: string; attachmentId?: string }) => ({
      id: 'msg_1', conversationId, body: d.body, attachmentId: d.attachmentId ?? null,
    })),
    findUserDisplayName: jest.fn(async () => 'Ann Dispatcher'),
    createConversation: jest.fn(async () => ({
      id: 'cnv_9', type: 'DIRECT', title: null,
      participants: [{ userId: 'usr_1', driverId: null }, { userId: null, driverId: 'drv_1' }],
    })),
  };
  const chat = { decorate: jest.fn(async (ms: Array<Record<string, unknown>>) => ms.map((m) => ({ ...m, type: 'TEXT', attachment: null }))), assertSendable: jest.fn(async () => undefined) };
  const push = { sendToDriver: jest.fn(async () => undefined) };
  const events = { publish: jest.fn(async () => undefined) };
  const service = new MessagingService(repo as never, events as never, push as never, chat as never);
  return { service, repo, push, events, chat };
}

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

describe('MessagingService — chat FCM', () => {
  const conv = { id: 'cnv_1', participants: [{ userId: 'usr_1', driverId: null }, { userId: null, driverId: 'drv_1' }] };

  it('pushes the driver participant when staff sends (identifiers only in data)', async () => {
    const { service, push } = buildService(conv);
    await service.sendMessage('cnv_1', { body: 'x'.repeat(150) }, actor);
    expect(push.sendToDriver).toHaveBeenCalledTimes(1);
    const [driverId, notification, data] = push.sendToDriver.mock.calls[0] as unknown as [string, { title: string; body: string }, Record<string, string>];
    expect(driverId).toBe('drv_1');
    expect(notification.title).toBe('Ann Dispatcher');
    expect(notification.body.length).toBeLessThanOrEqual(100);
    expect(data).toEqual({ type: 'message.new', conversationId: 'cnv_1', messageId: 'msg_1', driverId: 'drv_1' });
  });

  it('uses "Sent an attachment" for an empty body with an attachment', async () => {
    const { service, push } = buildService(conv);
    await service.sendMessage('cnv_1', { body: '', attachmentId: 'att_1' }, actor);
    expect(push.sendToDriver).toHaveBeenCalledWith('drv_1', expect.objectContaining({ body: 'Sent an attachment' }), expect.anything());
  });

  it('MB-9 verifies attachment ownership before sending and returns type + attachment', async () => {
    const { service, chat } = buildService(conv);
    const out = await service.sendMessage('cnv_1', { body: '', attachmentId: 'att_1' }, actor);
    expect(chat.assertSendable).toHaveBeenCalledWith('att_1', actor);
    expect(out).toMatchObject({ type: 'TEXT', attachment: null });
  });

  it('MB-9 a foreign attachment aborts the send before any row is written', async () => {
    const { service, chat, repo } = buildService(conv);
    chat.assertSendable.mockRejectedValueOnce(new Error('nope'));
    await expect(service.sendMessage('cnv_1', { body: '', attachmentId: 'att_x' }, actor)).rejects.toThrow('nope');
    expect(repo.createMessage).not.toHaveBeenCalled();
  });

  it('never pushes when a driver sends', async () => {
    const { service, push } = buildService(conv);
    await service.sendMessage('cnv_1', { body: 'hi' }, { id: 'drv_1', type: 'driver' } as never);
    expect(push.sendToDriver).not.toHaveBeenCalled();
  });

  it('a push failure never fails the send', async () => {
    const { service, push } = buildService(conv);
    push.sendToDriver.mockRejectedValueOnce(new Error('fcm down'));
    await expect(service.sendMessage('cnv_1', { body: 'hi' }, actor)).resolves.toMatchObject({ id: 'msg_1' });
  });
});

describe('MessagingService — MB-8 conversation.new to the driver room', () => {
  it('staff opening a conversation emits conversation.new to each driver participant', async () => {
    const { service, events } = buildService();
    await service.createConversation({ type: 'DIRECT', driverIds: ['drv_1'], userIds: [] } as never, actor);
    expect(events.publish).toHaveBeenCalledWith('realtime.push', {
      room: 'driver:drv_1',
      event: 'conversation.new',
      payload: { conversationId: 'cnv_9', type: 'DIRECT', title: null },
    });
  });

  it('a driver opening a conversation emits nothing to driver rooms', async () => {
    const { service, events } = buildService();
    await service.createConversation({ type: 'DIRECT', driverIds: [], userIds: ['usr_1'] } as never, { id: 'drv_1', type: 'driver' } as never);
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('an emit failure never fails the create', async () => {
    const { service, events } = buildService();
    events.publish.mockRejectedValueOnce(new Error('redis down'));
    await expect(service.createConversation({ type: 'DIRECT', driverIds: ['drv_1'], userIds: [] } as never, actor)).resolves.toMatchObject({ id: 'cnv_9' });
  });
});
