import { generateKeyPairSync } from 'node:crypto';
import { AppException } from '../../common/errors/app.exception';
import { FmcsaEncryptionService } from './fmcsa-encryption.service';
import { FmcsaTransferService, SendTransferInput } from './fmcsa-transfer.service';
import type { MailMessage, MailPort, MailSendResult } from './mail.port';

const publicPem = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .publicKey.export({ type: 'spki', format: 'pem' })
  .toString();

class RecordingMailer implements MailPort {
  sent: MailMessage[] = [];
  result: MailSendResult = { delivered: true, reference: 'msg-1' };
  async send(message: MailMessage): Promise<MailSendResult> {
    this.sent.push(message);
    return this.result;
  }
}

function makeService(
  env: Record<string, string | undefined> = {},
  mailer: MailPort = new RecordingMailer(),
): FmcsaTransferService {
  const config = {
    get: (key: string) =>
      ({
        FMCSA_PUBLIC_KEY: publicPem,
        FMCSA_EMAIL_SUBJECT_TEMPLATE: 'ELD Output File: {fileName}',
        FMCSA_WEB_SERVICES_URL: 'https://eld.fmcsa.dot.gov/api/submit',
        ...env,
      })[key],
  } as never;
  return new FmcsaTransferService(config, new FmcsaEncryptionService(config), mailer);
}

function input(overrides: Partial<SendTransferInput> = {}): SendTransferInput {
  return {
    transferId: 'trf_1',
    method: 'EMAIL',
    erodsMode: 'PRODUCTION',
    fileName: 'SMITH38018.csv',
    fileBytes: Buffer.from('ELD File Header Segment:\r\n'),
    outputFileComment: 'Roadside inspection',
    recipient: 'eldsubmissions@fmcsa.dot.gov',
    ...overrides,
  };
}

describe('FmcsaTransferService — recipient restriction (§10.4, §23)', () => {
  it.each(['driver@gmail.com', 'inspector@dot.gov', 'x@fmcsa.dot.gov.evil.com', ''])(
    'rejects %s with 422 INVALID_TRANSFER_RECIPIENT at request time',
    (recipient) => {
      const svc = makeService();
      expect(() => svc.assertValidRequest('EMAIL', recipient)).toThrow(AppException);
      try {
        svc.assertValidRequest('EMAIL', recipient);
      } catch (err) {
        expect((err as AppException).code).toBe('INVALID_TRANSFER_RECIPIENT');
        expect((err as AppException).getStatus()).toBe(422);
      }
    },
  );

  it('rejects an EMAIL transfer with no recipient at all', () => {
    expect(() => makeService().assertValidRequest('EMAIL', null)).toThrow(AppException);
  });

  it('rejects a non-FMCSA recipient again inside send(), not only in the DTO', async () => {
    await expect(makeService().send(input({ recipient: 'driver@gmail.com' }))).rejects.toMatchObject({
      code: 'INVALID_TRANSFER_RECIPIENT',
    });
  });

  it('does not constrain the recipient for a WEB_SERVICES transfer', () => {
    expect(() => makeService().assertValidRequest('WEB_SERVICES', null)).not.toThrow();
  });

  it('accepts an fmcsa.dot.gov recipient', () => {
    expect(() => makeService().assertValidRequest('EMAIL', 'eldsubmissions@fmcsa.dot.gov')).not.toThrow();
  });
});

describe('FmcsaTransferService — TEST mode (§10.1)', () => {
  it('does NOT send in TEST mode and records TEST_ONLY', async () => {
    const mailer = new RecordingMailer();
    const result = await makeService({}, mailer).send(input({ erodsMode: 'TEST' }));
    expect(result.status).toBe('TEST_ONLY');
    expect(result.sentAt).toBeNull();
    expect(mailer.sent).toHaveLength(0);
    expect(result.responseBody).toContain('erodsMode=TEST');
  });

  it('still enforces the recipient rule in TEST mode', async () => {
    await expect(
      makeService().send(input({ erodsMode: 'TEST', recipient: 'someone@example.com' })),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSFER_RECIPIENT' });
  });

  it('does not touch the web-services endpoint in TEST mode', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const result = await makeService().send(input({ method: 'WEB_SERVICES', erodsMode: 'TEST', recipient: null }));
    expect(result.status).toBe('TEST_ONLY');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('switching to PRODUCTION needs no code change — only the erodsMode value differs', async () => {
    const mailer = new RecordingMailer();
    const svc = makeService({}, mailer);
    expect((await svc.send(input({ erodsMode: 'TEST' }))).status).toBe('TEST_ONLY');
    expect((await svc.send(input({ erodsMode: 'PRODUCTION' }))).status).toBe('SENT');
    expect(mailer.sent).toHaveLength(1);
  });
});

describe('FmcsaTransferService — email encryption (§10.4)', () => {
  it('encrypts the payload before handing it to the transport and sets encrypted = true', async () => {
    const mailer = new RecordingMailer();
    const result = await makeService({}, mailer).send(input());
    expect(result.encrypted).toBe(true);
    expect(result.status).toBe('SENT');
    const [message] = mailer.sent;
    expect(message.to).toBe('eldsubmissions@fmcsa.dot.gov');
    expect(message.subject).toBe('ELD Output File: SMITH38018.csv');
    expect(message.attachments[0].filename).toBe('SMITH38018.csv.enc');
    // The plaintext header must NOT appear anywhere in the attachment.
    expect(message.attachments[0].content.toString('utf8')).not.toContain('ELD File Header Segment');
  });

  it('refuses to email anything when no FMCSA public key is configured', async () => {
    await expect(makeService({ FMCSA_PUBLIC_KEY: undefined }).send(input())).rejects.toMatchObject({
      code: 'TRANSFER_ENCRYPTION_UNAVAILABLE',
    });
  });

  it('reports FAILED (not SENT) when the transport does not dispatch', async () => {
    const mailer = new RecordingMailer();
    mailer.result = { delivered: false, reference: 'NO_MAIL_TRANSPORT' };
    const result = await makeService({}, mailer).send(input());
    expect(result.status).toBe('FAILED');
    expect(result.responseCode).toBe('NO_MAIL_TRANSPORT');
    // The bytes were encrypted even though delivery failed.
    expect(result.encrypted).toBe(true);
  });
});

describe('FmcsaTransferService — web services (§10.4: TLS only, no payload encryption)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('posts the plain CSV over TLS and records encrypted = false', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'x-submission-id': 'sub-9' }),
      text: async () => 'accepted',
    } as never);
    const result = await makeService().send(input({ method: 'WEB_SERVICES', recipient: null }));
    expect(fetchMock).toHaveBeenCalledWith(
      'https://eld.fmcsa.dot.gov/api/submit',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result).toMatchObject({ status: 'SENT', encrypted: false, referenceId: 'sub-9', responseCode: '200' });
  });

  it('records FAILED on a non-2xx response', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 503,
      headers: new Headers(),
      text: async () => 'unavailable',
    } as never);
    const result = await makeService().send(input({ method: 'WEB_SERVICES', recipient: null }));
    expect(result).toMatchObject({ status: 'FAILED', responseCode: '503', sentAt: null });
  });

  it('fails loudly when the web-services endpoint is not configured', async () => {
    await expect(
      makeService({ FMCSA_WEB_SERVICES_URL: undefined }).send(input({ method: 'WEB_SERVICES', recipient: null })),
    ).rejects.toMatchObject({ code: 'INTEGRATION_NOT_CONFIGURED' });
  });
});
