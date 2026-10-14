import { UsersRepository } from './users.repository';

describe('UsersRepository', () => {
  let user: { findMany: jest.Mock; findUnique: jest.Mock; findFirst: jest.Mock };
  let repo: UsersRepository;

  beforeEach(() => {
    user = { findMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn() };
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
        pendingEmail: true,
        pendingEmailRequestedAt: true,
        role: { select: { id: true, key: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('findByIdWithRole queries by id with role included', async () => {
    await repo.findByIdWithRole('usr_1');
    expect(user.findUnique).toHaveBeenCalledWith({ where: { id: 'usr_1' }, include: { role: true } });
  });

  it('findByEmail trims + lower-cases and matches case-insensitively with LIKE metacharacters escaped', async () => {
    await repo.findByEmail('  A_b@B.com ');
    expect(user.findFirst).toHaveBeenCalledWith({ where: { email: { equals: 'a\\_b@b.com', mode: 'insensitive' } } });
  });

  it('findByEmailInsensitive uses the same normalized, escaped filter', async () => {
    await repo.findByEmailInsensitive(' John@X.com');
    expect(user.findFirst).toHaveBeenCalledWith({ where: { email: { equals: 'john@x.com', mode: 'insensitive' } } });
  });
});
