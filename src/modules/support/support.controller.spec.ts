import 'reflect-metadata';
import { PERM_METADATA_KEY, PermRequirement } from '../../common/decorators/perm.decorator';
import { SupportController } from './support.controller';

function permOf(method: keyof SupportController): PermRequirement | undefined {
  return Reflect.getMetadata(PERM_METADATA_KEY, SupportController.prototype[method]) as PermRequirement | undefined;
}

describe('SupportController permissions', () => {
  it.each([
    ['list', 'READ'],
    ['get', 'READ'],
    ['create', 'READ'], // B-12 — VIEWER (support:READ) can still submit a ticket.
    ['update', 'FULL'],
    ['createFeedback', 'READ'], // B-12
    ['createChat', 'READ'], // B-90

  ] as const)('%s requires support:%s', (method, level) => {
    expect(permOf(method)).toEqual({ key: 'support', level });
  });
});

describe('SupportController — delegates to SupportService', () => {
  const service = {
    list: jest.fn().mockResolvedValue({ items: [], page: 1, limit: 25, total: 0, totalPages: 0 }),
    get: jest.fn().mockResolvedValue({ id: 'tck_1' }),
    create: jest.fn().mockResolvedValue({ id: 'tck_1' }),
    update: jest.fn().mockResolvedValue({ id: 'tck_1' }),
    createFeedback: jest.fn().mockResolvedValue({ id: 'fb_1' }),
    createChat: jest.fn().mockResolvedValue({ conversationId: 'cnv_1', messageId: 'msg_1' }),
  };
  const controller = new SupportController(service as never);
  const requester = { id: 'usr_1', type: 'user' as const };

  it('list', async () => {
    const query = { page: 1, limit: 25 } as never;
    await controller.list(query);
    expect(service.list).toHaveBeenCalledWith(query);
  });

  it('get', async () => {
    await controller.get('tck_1');
    expect(service.get).toHaveBeenCalledWith('tck_1');
  });

  it('create', async () => {
    const dto = { subject: 'Help', body: 'body', priority: 'NORMAL' } as never;
    await controller.create(dto, requester);
    expect(service.create).toHaveBeenCalledWith(dto, requester);
  });

  it('update', async () => {
    const dto = { status: 'RESOLVED' } as never;
    await controller.update('tck_1', dto);
    expect(service.update).toHaveBeenCalledWith('tck_1', dto);
  });

  it('createFeedback', async () => {
    const dto = { answers: { rating: 5 } } as never;
    await controller.createFeedback(dto, requester);
    expect(service.createFeedback).toHaveBeenCalledWith(dto, requester);
  });

  it('createChat', async () => {
    const dto = { message: 'Hi' } as never;
    await controller.createChat(dto, requester);
    expect(service.createChat).toHaveBeenCalledWith(dto, requester);
  });
});
