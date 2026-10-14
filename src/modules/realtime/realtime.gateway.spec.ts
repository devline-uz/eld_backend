import type { RealtimePushPayload } from '../../core/events/realtime-pubsub.service';
import { RealtimeGateway } from './realtime.gateway';

/** The gateway relays every `realtime.push` with ONE `server.to(room | rooms).emit()` call — for a
 * multi-room push (chat `message.new`: conversation room + staff identity rooms) Socket.IO
 * unions the rooms, so a socket in several of them still receives the event once. */
describe('RealtimeGateway relay', () => {
  function build() {
    let relay: ((p: RealtimePushPayload) => void) | undefined;
    const pubsub = { onRelayed: jest.fn((h: (p: RealtimePushPayload) => void) => ((relay = h), () => undefined)) };
    const emit = jest.fn();
    const to = jest.fn(() => ({ emit }));
    const disconnectSockets = jest.fn();
    const inRoom = jest.fn(() => ({ disconnectSockets }));
    const gateway = new RealtimeGateway({} as never, pubsub as never, {} as never);
    gateway.server = { to, in: inRoom } as never;
    gateway.onModuleInit();
    return { relay: (p: RealtimePushPayload) => relay!(p), to, emit, inRoom, disconnectSockets };
  }

  it('CODE-012 — auth.revoked tells the user\'s sockets and disconnects them', () => {
    const { relay, to, emit, inRoom, disconnectSockets } = build();
    relay({ room: 'user:u1', event: 'auth.revoked', payload: {} });
    expect(to).toHaveBeenCalledWith('user:u1');
    expect(emit).toHaveBeenCalledWith('auth.revoked', {});
    expect(inRoom).toHaveBeenCalledWith('user:u1');
    expect(disconnectSockets).toHaveBeenCalledWith(true);
  });

  it('an ordinary push never disconnects anyone', () => {
    const { relay, disconnectSockets } = build();
    relay({ room: 'fleet', event: 'telemetry.point', payload: {} });
    expect(disconnectSockets).not.toHaveBeenCalled();
  });

  it('emits a single-room push to that room', () => {
    const { relay, to, emit } = build();
    relay({ room: 'user:u1', event: 'report.ready', payload: { reportId: 'r1' } });
    expect(to).toHaveBeenCalledWith('user:u1');
    expect(emit).toHaveBeenCalledWith('report.ready', { reportId: 'r1' });
  });

  it('emits a multi-room push with ONE to([...rooms]) call (one delivery per socket)', () => {
    const { relay, to, emit } = build();
    const rooms = ['conversation:c1', 'user:u1', 'user:u2'];
    relay({ room: rooms, event: 'message.new', payload: { conversationId: 'c1', message: { id: 'm1' } } });
    expect(to).toHaveBeenCalledTimes(1);
    expect(to).toHaveBeenCalledWith(rooms);
    expect(emit).toHaveBeenCalledTimes(1);
  });
});

describe('RealtimeGateway typing relay', () => {
  function build(mayJoin: boolean) {
    const rooms = { mayJoin: jest.fn(async () => mayJoin) };
    const gateway = new RealtimeGateway({} as never, {} as never, rooms as never);
    const emit = jest.fn();
    const to = jest.fn(() => ({ emit }));
    const socket = { data: { user: { id: 'usr_1', type: 'user' } }, to } as never;
    return { gateway, rooms, socket, to, emit };
  }

  it('relays typing to the conversation room excluding the sender', async () => {
    const { gateway, socket, to, emit } = build(true);
    await expect(gateway.onTyping(socket, { conversationId: 'c1', isTyping: true })).resolves.toEqual({ ok: true });
    expect(to).toHaveBeenCalledWith('conversation:c1');
    expect(emit).toHaveBeenCalledWith('typing', { conversationId: 'c1', userType: 'STAFF', userId: 'usr_1', isTyping: true });
  });

  it('rejects a socket that is not a participant', async () => {
    const { gateway, socket, emit } = build(false);
    await expect(gateway.onTyping(socket, { conversationId: 'c1', isTyping: true })).resolves.toEqual({ ok: false });
    expect(emit).not.toHaveBeenCalled();
  });

  it('rejects a malformed payload and an unauthenticated socket', async () => {
    const { gateway, socket, emit } = build(true);
    await expect(gateway.onTyping(socket, { conversationId: 'c1', isTyping: 'yes' })).resolves.toEqual({ ok: false });
    await expect(gateway.onTyping({ data: {} } as never, { conversationId: 'c1', isTyping: true })).resolves.toEqual({ ok: false });
    expect(emit).not.toHaveBeenCalled();
  });

  it('drops the same state repeated within 2 s but relays a state change', async () => {
    const { gateway, socket, emit } = build(true);
    await gateway.onTyping(socket, { conversationId: 'c1', isTyping: true });
    await gateway.onTyping(socket, { conversationId: 'c1', isTyping: true });
    expect(emit).toHaveBeenCalledTimes(1);
    await gateway.onTyping(socket, { conversationId: 'c1', isTyping: false });
    expect(emit).toHaveBeenCalledTimes(2);
  });
});
