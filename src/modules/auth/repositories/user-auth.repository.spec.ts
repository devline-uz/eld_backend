import { fakeUserEmailTable } from '../../../../test/helpers/fake-user-email-table';
import { UserAuthRepository } from './user-auth.repository';

type Row = { id: string; email: string; role: { key: string } };

describe('UserAuthRepository email lookups', () => {
  const lower: Row = { id: 'usr_lower', email: 'john@x.com', role: { key: 'ADMIN' } };
  const legacy: Row = { id: 'usr_legacy', email: 'Legacy.User@Example.COM', role: { key: 'DISPATCHER' } };
  const underscored: Row = { id: 'usr_us', email: 'j_hn@y.com', role: { key: 'ADMIN' } };

  let repo: UserAuthRepository;
  let findFirst: jest.Mock;

  beforeEach(() => {
    const fake = fakeUserEmailTable<Row>([lower, legacy, underscored]);
    findFirst = fake.findFirst;
    repo = new UserAuthRepository(fake.prisma as never);
  });

  it.each([' John@X.com ', 'JOHN@X.COM', '\tjohn@x.com\n'])(
    'findByEmailWithRole(%j) matches the lower-case stored address',
    async (input) => {
      await expect(repo.findByEmailWithRole(input)).resolves.toMatchObject({ id: 'usr_lower' });
      expect(findFirst).toHaveBeenCalledWith({ where: { email: { equals: 'john@x.com', mode: 'insensitive' } }, include: { role: true } });
    },
  );

  it.each(['legacy.user@example.com', '  LEGACY.USER@EXAMPLE.COM '])(
    'findByEmailWithRole(%j) matches a legacy mixed-case stored address',
    async (input) => {
      await expect(repo.findByEmailWithRole(input)).resolves.toMatchObject({ id: 'usr_legacy' });
    },
  );

  it('treats `_` and `%` literally — one address can never resolve to another account', async () => {
    await expect(repo.findByEmailWithRole('j_hn@x.com')).resolves.toBeNull();
    await expect(repo.findByEmailWithRole('%')).resolves.toBeNull();
    await expect(repo.findByEmailWithRole('J_HN@Y.COM')).resolves.toMatchObject({ id: 'usr_us' });
  });

  it('unknown address → null', async () => {
    await expect(repo.findByEmailWithRole('nobody@x.com')).resolves.toBeNull();
  });

  it('findByEmail uses the same normalized filter', async () => {
    await expect(repo.findByEmail(' Legacy.User@example.com')).resolves.toMatchObject({ id: 'usr_legacy' });
  });
});
