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
    const gateway = new RealtimeGateway({} as never, pubsub as never, {} as never);
    gateway.server = { to } as never;
    gateway.onModuleInit();
    return { relay: (p: RealtimePushPayload) => relay!(p), to, emit };
  }

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
