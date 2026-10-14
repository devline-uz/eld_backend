import { DriverAuthRepository } from './driver-auth.repository';

describe('DriverAuthRepository.findByUsernameOrEmail', () => {
  it('matches username exactly or email trimmed / case-insensitively with LIKE metacharacters escaped', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const repo = new DriverAuthRepository({ driver: { findFirst } } as never);

    await repo.findByUsernameOrEmail(' J_Smith@X.com ');

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        OR: [{ username: ' J_Smith@X.com ' }, { email: { equals: 'j\\_smith@x.com', mode: 'insensitive' } }],
      },
    });
  });
});
