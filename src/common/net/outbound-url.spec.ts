import { assertPublicDestination, BlockedDestinationError, isBlockedAddress, outboundUrlProblem } from './outbound-url';

describe('outbound URL guard (CODE-018)', () => {
  it.each([
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.0.0.8', '192.0.2.1', '192.168.1.1', '198.18.0.1', '198.51.100.7', '203.0.113.9', '224.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '2001:db8::1', '64:ff9b::a00:1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '[::1]', 'fe80::1%en0', 'not-an-ip',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows public %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it('accepts only https to a public host, without credentials', () => {
    expect(outboundUrlProblem('https://hooks.example.com/x')).toBeNull();
    expect(outboundUrlProblem('https://8.8.8.8/x')).toBeNull();
    expect(outboundUrlProblem('http://hooks.example.com/x')).toMatch(/https/);
    expect(outboundUrlProblem('ftp://hooks.example.com')).toMatch(/https/);
    expect(outboundUrlProblem('not a url')).toMatch(/https/);
    expect(outboundUrlProblem('https://user:pw@hooks.example.com')).toMatch(/password/);
    expect(outboundUrlProblem('https://localhost/x')).toMatch(/public/);
    expect(outboundUrlProblem('https://api.localhost./x')).toMatch(/public/);
    expect(outboundUrlProblem('https://169.254.169.254/latest')).toMatch(/public/);
    expect(outboundUrlProblem('https://[::1]:8443/x')).toMatch(/public/);
  });

  it('checks every resolved address at send time', async () => {
    const lookup = jest.fn(async (host: string) =>
      host === 'mixed.example' ? [{ address: '93.184.216.34' }, { address: '10.0.0.1' }] : [{ address: '93.184.216.34' }],
    );
    await expect(assertPublicDestination('https://ok.example/hook', lookup)).resolves.toBeUndefined();
    await expect(assertPublicDestination('https://mixed.example/hook', lookup)).rejects.toBeInstanceOf(BlockedDestinationError);
    await expect(assertPublicDestination('https://8.8.8.8/hook', lookup)).resolves.toBeUndefined();
    expect(lookup).toHaveBeenCalledTimes(2);
    await expect(assertPublicDestination('http://ok.example/hook', lookup)).rejects.toThrow(/https/);
    await expect(assertPublicDestination('https://none.example', async () => [])).rejects.toThrow(/private or reserved/);
    await expect(
      assertPublicDestination('https://gone.example', async () => {
        throw new Error('ENOTFOUND');
      }),
    ).rejects.toThrow(/could not be resolved/);
  });
});
