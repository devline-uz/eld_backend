import { compactData, PushService } from './push.service';

function build(sendImpl: (token: string) => Promise<string>, enabled = true) {
  const firebase = { enabled, sendToToken: jest.fn(async (t: string) => sendImpl(t)) };
  const prisma = {
    findByDriver: jest.fn(async () => [{ token: 'tok_a' }, { token: 'tok_b' }]),
    deleteTokens: jest.fn(async () => 1),
  };
  return { service: new PushService(firebase as never, prisma as never), firebase, prisma };
}

describe('PushService', () => {
  it('compactData omits null/undefined/empty keys', () => {
    expect(compactData({ a: '1', b: null, c: undefined, d: '' })).toEqual({ a: '1' });
  });

  it('sends to all tokens with compacted data', async () => {
    const { service, firebase } = build(async () => 'ok');
    await service.sendToDriver('drv_1', { title: 't', body: 'b' }, { type: 'x', objectId: null });
    expect(firebase.sendToToken).toHaveBeenCalledTimes(2);
    expect(firebase.sendToToken).toHaveBeenCalledWith('tok_a', { title: 't', body: 'b' }, { type: 'x' });
  });

  it.each(['messaging/registration-token-not-registered', 'messaging/invalid-argument', 'messaging/invalid-registration-token'])(
    'deletes only the dead token on %s',
    async (code) => {
      const { service, prisma } = build(async (t) => {
        if (t === 'tok_a') throw Object.assign(new Error('dead'), { code });
        return 'ok';
      });
      await service.sendToDriver('drv_1', { title: 't', body: 'b' }, {});
      expect(prisma.deleteTokens).toHaveBeenCalledWith(['tok_a']);
    },
  );

  it('keeps tokens on other errors', async () => {
    const { service, prisma } = build(async () => {
      throw Object.assign(new Error('x'), { code: 'messaging/internal-error' });
    });
    await service.sendToDriver('drv_1', { title: 't', body: 'b' }, {});
    expect(prisma.deleteTokens).not.toHaveBeenCalled();
  });

  it('does nothing when Firebase is disabled', async () => {
    const { service, prisma } = build(async () => 'ok', false);
    await service.sendToDriver('drv_1', { title: 't', body: 'b' }, {});
    expect(prisma.findByDriver).not.toHaveBeenCalled();
  });
});
