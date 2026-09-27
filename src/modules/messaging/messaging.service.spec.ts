import { MessagingService } from './messaging.service';

function buildService(conversation: unknown = { id: 'cnv_1' }, isParticipant = true) {
  const repo = {
    findById: jest.fn(async () => conversation),
    isParticipant: jest.fn(async () => isParticipant),
    markRead: jest.fn(async () => undefined),
    listForActor: jest.fn(async () => []),
  };
  const events = { publish: jest.fn(async () => undefined) };
  const service = new MessagingService(repo as never, events as never);
  return { service, repo };
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
