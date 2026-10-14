import { NotificationChannelsDto } from './notifications.dto';

describe('NotificationChannelsDto (CODE-084 — the org webhook URL is now delivered to)', () => {
  it('accepts a public https URL', () => {
    expect(NotificationChannelsDto.safeParse({ webhook: { enabled: true, url: 'https://alerts.example.com/hook' } }).success).toBe(true);
  });

  it.each(['http://alerts.example.com/hook', 'https://127.0.0.1/x', 'https://localhost/x', 'https://169.254.169.254/latest', 'not a url'])(
    'refuses %s',
    (url) => {
      expect(NotificationChannelsDto.safeParse({ webhook: { enabled: true, url } }).success).toBe(false);
    },
  );

  it('accepts null to clear the URL', () => {
    expect(NotificationChannelsDto.safeParse({ webhook: { enabled: true, url: null } }).success).toBe(true);
  });
});
