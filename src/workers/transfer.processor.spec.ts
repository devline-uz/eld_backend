import { AppException } from '../common/errors/app.exception';
import { TransferProcessor } from './transfer.processor';

const TRANSFER = {
  id: 'trf_1',
  method: 'EMAIL' as const,
  status: 'QUEUED' as const,
  erodsMode: 'TEST' as const,
  fileName: 'SMITH38018.csv',
  fileKey: 'transfers/trf_1.csv',
  outputFileComment: 'Roadside inspection',
  responseBody: 'eldsubmissions@fmcsa.dot.gov',
  attempts: 0,
  requestedById: 'usr_1',
  requestedByType: 'USER' as const,
};

function harness(overrides: { transfer?: unknown; carrier?: unknown; sendResult?: unknown } = {}) {
  const repo = {
    findTransfer: jest.fn().mockResolvedValue(overrides.transfer === undefined ? TRANSFER : overrides.transfer),
    findCarrier: jest.fn().mockResolvedValue(overrides.carrier ?? { erodsMode: 'TEST' }),
    updateTransfer: jest.fn().mockResolvedValue({}),
  };
  const transfers = { loadFile: jest.fn().mockResolvedValue(Buffer.from('ELD File Header Segment:\r\n')) };
  const fmcsa = {
    send: jest.fn().mockResolvedValue(
      overrides.sendResult ?? {
        status: 'TEST_ONLY',
        encrypted: false,
        referenceId: null,
        responseCode: 'TEST_ONLY',
        responseBody: 'erodsMode=TEST',
        sentAt: null,
      },
    ),
  };
  const audit = { insert: jest.fn().mockResolvedValue({}) };
  const processor = new TransferProcessor(repo as never, transfers as never, fmcsa as never, audit as never);
  return { processor, repo, transfers, fmcsa, audit };
}

const job = { data: { transferId: 'trf_1' } } as never;

describe('TransferProcessor (tz.md §10.1 / §10.4)', () => {
  it('records TEST_ONLY and audits that nothing was sent to FMCSA', async () => {
    const h = harness();
    await h.processor.process(job);
    expect(h.repo.updateTransfer).toHaveBeenCalledWith('trf_1', expect.objectContaining({ status: 'TEST_ONLY' }));
    expect(h.audit.insert).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ERODS_TRANSFER_TEST_ONLY', objectId: 'trf_1' }),
    );
  });

  it('reads erodsMode from the carrier profile, not the transfer row (settings-only toggle)', async () => {
    const h = harness({ carrier: { erodsMode: 'PRODUCTION' } });
    await h.processor.process(job);
    expect(h.fmcsa.send).toHaveBeenCalledWith(expect.objectContaining({ erodsMode: 'PRODUCTION' }));
  });

  it('falls back to the row erodsMode when no carrier profile exists', async () => {
    const h = harness({ carrier: null });
    await h.processor.process(job);
    expect(h.fmcsa.send).toHaveBeenCalledWith(expect.objectContaining({ erodsMode: 'TEST' }));
  });

  it('passes the recipient parked on the row to the send step', async () => {
    const h = harness();
    await h.processor.process(job);
    expect(h.fmcsa.send).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: 'eldsubmissions@fmcsa.dot.gov' }),
    );
  });

  it('passes no recipient for a web-services transfer', async () => {
    const h = harness({ transfer: { ...TRANSFER, method: 'WEB_SERVICES' } });
    await h.processor.process(job);
    expect(h.fmcsa.send).toHaveBeenCalledWith(expect.objectContaining({ recipient: null }));
  });

  it('marks a dispatched email transfer SENT with encrypted = true', async () => {
    const h = harness({
      carrier: { erodsMode: 'PRODUCTION' },
      sendResult: {
        status: 'SENT',
        encrypted: true,
        referenceId: 'msg-1',
        responseCode: 'SENT',
        responseBody: 'env',
        sentAt: new Date('2026-09-11T18:00:00Z'),
      },
    });
    await h.processor.process(job);
    expect(h.repo.updateTransfer).toHaveBeenCalledWith(
      'trf_1',
      expect.objectContaining({ status: 'SENT', encrypted: true, attempts: 1 }),
    );
  });

  it('FAILS an email transfer that claims SENT with encrypted = false (§10.4)', async () => {
    const h = harness({
      carrier: { erodsMode: 'PRODUCTION' },
      sendResult: { status: 'SENT', encrypted: false, referenceId: 'x', responseCode: 'SENT', responseBody: '', sentAt: new Date() },
    });
    await expect(h.processor.process(job)).rejects.toMatchObject({ code: 'TRANSFER_NOT_ENCRYPTED' });
    expect(h.repo.updateTransfer).toHaveBeenCalledWith(
      'trf_1',
      expect.objectContaining({ status: 'FAILED', responseCode: 'TRANSFER_NOT_ENCRYPTED' }),
    );
  });

  it('allows encrypted = false for a web-services transfer (TLS is enough)', async () => {
    const h = harness({
      transfer: { ...TRANSFER, method: 'WEB_SERVICES' },
      carrier: { erodsMode: 'PRODUCTION' },
      sendResult: { status: 'SENT', encrypted: false, referenceId: 'x', responseCode: '200', responseBody: 'ok', sentAt: new Date() },
    });
    await expect(h.processor.process(job)).resolves.toBeUndefined();
    expect(h.repo.updateTransfer).toHaveBeenCalledWith('trf_1', expect.objectContaining({ status: 'SENT' }));
  });

  it('records FAILED and rethrows when the send step throws', async () => {
    const h = harness({ carrier: { erodsMode: 'PRODUCTION' } });
    h.fmcsa.send.mockRejectedValue(
      AppException.unprocessable('TRANSFER_ENCRYPTION_UNAVAILABLE', 'no key'),
    );
    await expect(h.processor.process(job)).rejects.toMatchObject({ code: 'TRANSFER_ENCRYPTION_UNAVAILABLE' });
    expect(h.repo.updateTransfer).toHaveBeenCalledWith(
      'trf_1',
      expect.objectContaining({ status: 'FAILED', responseCode: 'TRANSFER_ENCRYPTION_UNAVAILABLE', attempts: 1 }),
    );
  });

  it('skips a missing transfer row without throwing', async () => {
    const h = harness({ transfer: null });
    await expect(h.processor.process(job)).resolves.toBeUndefined();
    expect(h.fmcsa.send).not.toHaveBeenCalled();
  });

  it('skips a transfer that is already resolved (idempotent retry)', async () => {
    const h = harness({ transfer: { ...TRANSFER, status: 'SENT' } });
    await h.processor.process(job);
    expect(h.fmcsa.send).not.toHaveBeenCalled();
    expect(h.repo.updateTransfer).not.toHaveBeenCalled();
  });
});
