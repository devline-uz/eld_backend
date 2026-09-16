import { UsersRepository } from './users.repository';

describe('UsersRepository', () => {
  let user: { findMany: jest.Mock; findUnique: jest.Mock };
  let repo: UsersRepository;

  beforeEach(() => {
    user = { findMany: jest.fn(), findUnique: jest.fn() };
    repo = new UsersRepository({ user } as never);
  });

  it('listWithRoles selects the lean W-18 fields (no passwordHash/permissions) and orders by createdAt desc', async () => {
    await repo.listWithRoles();
    expect(user.findMany).toHaveBeenCalledWith({
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        jobTitle: true,
        phone: true,
        status: true,
        lastActiveAt: true,
        invitedAt: true,
        createdAt: true,
        role: { select: { id: true, key: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('findByIdWithRole queries by id with role included', async () => {
    await repo.findByIdWithRole('usr_1');
    expect(user.findUnique).toHaveBeenCalledWith({ where: { id: 'usr_1' }, include: { role: true } });
  });

  it('findByEmail queries by email', async () => {
    await repo.findByEmail('a@b.com');
    expect(user.findUnique).toHaveBeenCalledWith({ where: { email: 'a@b.com' } });
  });
});
