import { AppException } from '../../common/errors/app.exception';
import { AppConfigService } from '../../core/config/config.service';
import type { StoragePort } from '../../core/storage/storage.port';
import type { AttachmentsService } from '../attachments/attachments.service';
import type { TokenService } from '../auth/token.service';
import type { MailPort } from '../transfers/mail.port';
import { DriversRepository } from './drivers.repository';
import { DriversService } from './drivers.service';
import { CreateDriverDocumentDto } from './dto/drivers.dto';

function makeDriver(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'drv_1',
    username: 'jsmith',
    passwordHash: 'argon2-hash',
    firstName: 'John',
    lastName: 'Smith',
    cdlNumber: 'D1234567',
    cdlState: 'OH',
    status: 'ACTIVE',
    homeTerminalName: 'Columbus, OH',
    homeTerminalTimezone: 'America/New_York',
    hosRuleset: 'US_70_8_PROPERTY',
    allowPersonalConveyance: false,
    allowYardMove: false,
    adverseDrivingEnabled: false,
    shortHaulException: false,
    splitSleeperEnabled: false,
    eldExempt: false,
    email: null,
    emailVerifiedAt: null,
    ...overrides,
  };
}

const baseDto = {
  username: 'jsmith',
  firstName: 'John',
  lastName: 'Smith',
  cdlNumber: 'D1234567',
  cdlState: 'OH',
  homeTerminalName: 'Columbus, OH',
  homeTerminalTimezone: 'America/New_York',
  hosRuleset: 'US_70_8_PROPERTY' as const,
  allowPersonalConveyance: false,
  allowYardMove: false,
  adverseDrivingEnabled: false,
  shortHaulException: false,
  splitSleeperEnabled: false,
  eldExempt: false,
  sendInvitation: false,
};

describe('DriversService', () => {
  let repo: jest.Mocked<
    Pick<
      DriversRepository,
      | 'findByUsername'
      | 'findByEmail'
      | 'findById'
      | 'create'
      | 'update'
      | 'delete'
      | 'list'
      | 'listAll'
      | 'listDocuments'
      | 'findDocument'
      | 'createDocument'
      | 'deleteDocument'
      | 'revokeAllSessions'
    >
  >;
  let tokens: jest.Mocked<Pick<TokenService, 'signDriverEmailVerifyToken' | 'verifyDriverEmailVerifyToken'>>;
  let mail: jest.Mocked<MailPort>;
  let storage: jest.Mocked<Pick<StoragePort, 'presignPut' | 'presignGet' | 'delete'>>;
  let attachments: jest.Mocked<Pick<AttachmentsService, 'presignKey'>>;
  let config: Pick<AppConfigService, 'isProduction' | 'echoOneTimeSecrets'>;
  let service: DriversService;

  beforeEach(() => {
    repo = {
      findByUsername: jest.fn(),
      findByEmail: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      list: jest.fn(),
      listAll: jest.fn(),
      listDocuments: jest.fn(),
      findDocument: jest.fn(),
      createDocument: jest.fn(),
      deleteDocument: jest.fn(),
      revokeAllSessions: jest.fn().mockResolvedValue(0),
    };
    repo.findByEmail.mockResolvedValue(null);
    tokens = { signDriverEmailVerifyToken: jest.fn(), verifyDriverEmailVerifyToken: jest.fn() };
    mail = { send: jest.fn().mockResolvedValue({ delivered: false, reference: 'not-configured' }) };
    storage = { presignPut: jest.fn().mockResolvedValue('https://minio/put'), presignGet: jest.fn().mockResolvedValue('https://minio/get'), delete: jest.fn().mockResolvedValue(undefined) };
    attachments = { presignKey: jest.fn().mockResolvedValue({ url: 'https://minio/get', expiresAt: '2026-09-24T00:15:00.000Z' }) };
    config = { isProduction: false, echoOneTimeSecrets: true };
    service = new DriversService(
      repo as unknown as DriversRepository,
      tokens as unknown as TokenService,
      config as AppConfigService,
      mail,
      storage as unknown as StoragePort,
      attachments as unknown as AttachmentsService,
    );
  });

  it('list parses sort and strips passwordHash from every row', async () => {
    repo.list.mockResolvedValue({ items: [makeDriver()], total: 1 } as never);
    const result = await service.list({ page: 1, limit: 25 });
    expect(repo.list).toHaveBeenCalledWith({ status: undefined, q: undefined }, 1, 25, { registeredAt: 'desc' });
    expect(result.items[0]).not.toHaveProperty('passwordHash');
  });

  it('get returns the driver view when found', async () => {
    repo.findById.mockResolvedValue(makeDriver() as never);
    const result = await service.get('drv_1');
    expect(result.username).toBe('jsmith');
    expect(result).not.toHaveProperty('passwordHash');
  });

  it('update applies a partial input and strips passwordHash', async () => {
    repo.findById.mockResolvedValue(makeDriver() as never);
    repo.update.mockResolvedValue(makeDriver({ firstName: 'Jane' }) as never);
    const result = await service.update('drv_1', { firstName: 'Jane', fleetManagerId: 'fm_1' });
    expect(repo.update).toHaveBeenCalledWith(
      { id: 'drv_1' },
      expect.objectContaining({ firstName: 'Jane', fleetManager: { connect: { id: 'fm_1' } } }),
    );
    expect(result).not.toHaveProperty('passwordHash');
  });

  it('update disconnects fleetManager when fleetManagerId is explicitly null', async () => {
    repo.findById.mockResolvedValue(makeDriver() as never);
    repo.update.mockResolvedValue(makeDriver() as never);
    await service.update('drv_1', { fleetManagerId: null } as never);
    expect(repo.update).toHaveBeenCalledWith({ id: 'drv_1' }, { fleetManager: { disconnect: true } });
  });

  it('update rejects an email already used by another driver', async () => {
    repo.findById.mockResolvedValue(makeDriver() as never);
    repo.findByEmail.mockResolvedValue(makeDriver({ id: 'drv_2' }) as never);
    await expect(service.update('drv_1', { email: 'taken@example.com' })).rejects.toThrow(AppException);
  });

  it('exportAll maps every driver to a CreateDriverDto shape, never including passwordHash', async () => {
    repo.listAll.mockResolvedValue([makeDriver({ email: null, phone: null, eldExemptReason: null })] as never);
    const rows = await service.exportAll();
    expect(rows[0]).not.toHaveProperty('passwordHash');
    expect(rows[0]).toEqual(expect.objectContaining({ username: 'jsmith', email: undefined }));
  });

  it('never returns passwordHash from get/create/update (TZ §6.5)', async () => {
    repo.findByUsername.mockResolvedValue(null);
    repo.create.mockResolvedValue(makeDriver() as never);

    const created = await service.create(baseDto);

    expect(created).not.toHaveProperty('passwordHash');
  });

  it('hashes a generated temp password when none is supplied', async () => {
    repo.findByUsername.mockResolvedValue(null);
    repo.create.mockResolvedValue(makeDriver() as never);

    await service.create(baseDto);

    const [createArg] = repo.create.mock.calls[0] as [{ passwordHash: string }];
    expect(createArg.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('rejects a duplicate username', async () => {
    repo.findByUsername.mockResolvedValue(makeDriver() as never);

    await expect(service.create(baseDto)).rejects.toThrow(AppException);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('B-82 — sendInvitation: false never dispatches a code; true (with an email) does', async () => {
    repo.findByUsername.mockResolvedValue(null);
    repo.create.mockResolvedValue(makeDriver({ email: 'jsmith@example.com' }) as never);

    const noInvite = await service.create(baseDto);
    expect(noInvite.inviteCode).toBeUndefined();
    expect(mail.send).not.toHaveBeenCalled();

    const withInvite = await service.create({ ...baseDto, sendInvitation: true, email: 'jsmith@example.com' });
    expect(withInvite.inviteCode).toMatch(/^\d{6}$/);
    expect(mail.send).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown driver id on update', async () => {
    repo.findById.mockResolvedValue(null);

    await expect(service.update('missing', {})).rejects.toThrow(AppException);
  });

  it('remove() soft-deletes (status -> TERMINATED), never calls repo.delete (bugs.md B-009)', async () => {
    repo.findById.mockResolvedValue(makeDriver() as never);
    repo.update.mockResolvedValue(makeDriver({ status: 'TERMINATED' }) as never);

    await service.remove('drv_1');

    expect(repo.update).toHaveBeenCalledWith({ id: 'drv_1' }, { status: 'TERMINATED', assignedVehicle: { disconnect: true } });
    expect(repo.delete).not.toHaveBeenCalled();
  });

  describe('resetPassword (B-81)', () => {
    it('emails the new code when the driver has an email on file', async () => {
      repo.findById.mockResolvedValue(makeDriver({ email: 'jsmith@example.com' }) as never);
      repo.update.mockResolvedValue(makeDriver() as never);

      const result = await service.resetPassword('drv_1');

      expect(result.emailedTo).toBe('jsmith@example.com');
      expect(mail.send).toHaveBeenCalledTimes(1);
      // B-094 — the old refresh tokens die with the old password.
      expect(repo.revokeAllSessions).toHaveBeenCalledWith('drv_1');
      const anyString: unknown = expect.any(String);
      expect(repo.update).toHaveBeenCalledWith({ id: 'drv_1' }, expect.objectContaining({ passwordHash: anyString }));
    });

    it('returns a dispatcher-readable code and no email when there is none on file', async () => {
      repo.findById.mockResolvedValue(makeDriver({ email: null }) as never);
      repo.update.mockResolvedValue(makeDriver() as never);

      const result = await service.resetPassword('drv_1');

      expect(result.emailedTo).toBeNull();
      expect(result.code).toMatch(/^\d{6}$/);
      expect(mail.send).not.toHaveBeenCalled();
      expect(repo.revokeAllSessions).toHaveBeenCalledWith('drv_1');
    });

    it('B-093 — never echoes an emailed code when echoOneTimeSecrets is off', async () => {
      config = { isProduction: false, echoOneTimeSecrets: false };
      service = new DriversService(repo as never, tokens as never, config as never, mail, storage as never, attachments as never);
      repo.findById.mockResolvedValue(makeDriver({ email: 'jsmith@example.com' }) as never);
      repo.update.mockResolvedValue(makeDriver() as never);

      const result = await service.resetPassword('drv_1');

      expect(result).toEqual({ emailedTo: 'jsmith@example.com' });
    });
  });

  describe('email verification (B-29/B-30/B-31)', () => {
    it('sendVerification rejects a driver without an email', async () => {
      repo.findById.mockResolvedValue(makeDriver({ email: null }) as never);
      await expect(service.sendVerification('drv_1')).rejects.toThrow(AppException);
    });

    it('sendVerification signs and emails a token', async () => {
      repo.findById.mockResolvedValue(makeDriver({ email: 'jsmith@example.com' }) as never);
      tokens.signDriverEmailVerifyToken.mockReturnValue('signed-token');

      const result = await service.sendVerification('drv_1');

      expect(tokens.signDriverEmailVerifyToken).toHaveBeenCalledWith('drv_1', 'jsmith@example.com');
      expect(result.emailedTo).toBe('jsmith@example.com');
      expect(mail.send).toHaveBeenCalledTimes(1);
    });

    it('verifyEmail sets emailVerifiedAt when the token matches', async () => {
      repo.findById.mockResolvedValue(makeDriver({ email: 'jsmith@example.com' }) as never);
      tokens.verifyDriverEmailVerifyToken.mockReturnValue({ driverId: 'drv_1', email: 'jsmith@example.com' });
      repo.update.mockResolvedValue(makeDriver({ email: 'jsmith@example.com', emailVerifiedAt: new Date() }) as never);

      await service.verifyEmail('drv_1', { token: 'tok' });

      const anyDate: unknown = expect.any(Date);
      expect(repo.update).toHaveBeenCalledWith({ id: 'drv_1' }, { emailVerifiedAt: anyDate });
    });

    it('verifyEmail rejects a token issued for a different email', async () => {
      repo.findById.mockResolvedValue(makeDriver({ email: 'jsmith@example.com' }) as never);
      tokens.verifyDriverEmailVerifyToken.mockReturnValue({ driverId: 'drv_1', email: 'stale@example.com' });

      await expect(service.verifyEmail('drv_1', { token: 'tok' })).rejects.toThrow(AppException);
    });
  });

  describe('documents (B-94)', () => {
    it('createDocument presigns a PUT and stores metadata', async () => {
      repo.findById.mockResolvedValue(makeDriver() as never);
      repo.createDocument.mockResolvedValue({
        id: 'doc_1',
        driverId: 'drv_1',
        type: 'CDL',
        fileName: 'front.jpg',
        fileKey: 'driver-documents/drv_1/abc-front.jpg',
        expiresAt: null,
        uploadedById: null,
        createdAt: new Date('2026-09-24T00:00:00.000Z'),
      });

      const result = await service.createDocument('drv_1', { type: 'CDL', fileName: '../../avatars/x/evil.html', contentType: 'image/jpeg', sizeBytes: 2048 });

      // B-091 — server-generated key (caller fileName never reaches it), content-type and
      // exact size bound into the PUT signature, 15-minute TTL.
      expect(storage.presignPut).toHaveBeenCalledWith(expect.stringMatching(/^driver-documents\/drv_1\/[0-9a-f]{32}\.jpg$/), 'image/jpeg', 900, 2048);
      expect(repo.createDocument).toHaveBeenCalledWith(expect.objectContaining({ fileName: '../../avatars/x/evil.html' }));
      expect(result.uploadUrl).toBe('https://minio/put');
      expect(result.url).toBe('https://minio/get');
    });

    it('B-091 — CreateDriverDocumentDto refuses active-content MIME types, missing size and oversize files', () => {
      const base = { type: 'CDL', fileName: 'cdl.pdf', contentType: 'application/pdf', sizeBytes: 1024 };
      expect(CreateDriverDocumentDto.safeParse(base).success).toBe(true);
      expect(CreateDriverDocumentDto.safeParse({ ...base, contentType: 'text/html' }).success).toBe(false);
      expect(CreateDriverDocumentDto.safeParse({ ...base, contentType: 'image/svg+xml' }).success).toBe(false);
      expect(CreateDriverDocumentDto.safeParse({ ...base, sizeBytes: undefined }).success).toBe(false);
      expect(CreateDriverDocumentDto.safeParse({ ...base, sizeBytes: 10 * 1024 * 1024 + 1 }).success).toBe(false);
    });

    it('deleteDocument rejects a document belonging to another driver', async () => {
      repo.findById.mockResolvedValue(makeDriver() as never);
      repo.findDocument.mockResolvedValue({ id: 'doc_1', driverId: 'drv_OTHER', fileKey: 'k' } as never);

      await expect(service.deleteDocument('drv_1', 'doc_1')).rejects.toThrow(AppException);
      expect(repo.deleteDocument).not.toHaveBeenCalled();
    });
  });

  describe('importMany', () => {
    it('creates new rows and updates existing ones by username (no options = prior behavior)', async () => {
      repo.findByUsername
        .mockResolvedValueOnce(null) // row 0: new
        .mockResolvedValueOnce(makeDriver() as never); // row 1: existing
      repo.create.mockResolvedValue(makeDriver() as never);
      repo.update.mockResolvedValue(makeDriver() as never);

      const summary = await service.importMany({ drivers: [baseDto, { ...baseDto, username: 'jsmith' }] });

      expect(summary).toEqual({ imported: 1, updated: 1, skipped: 0, failed: [] });
    });

    it('collects per-row failures instead of aborting the whole batch', async () => {
      repo.findByUsername.mockRejectedValue(new Error('db down'));

      const summary = await service.importMany({ drivers: [baseDto] });

      expect(summary.imported).toBe(0);
      expect(summary.failed).toEqual([{ index: 0, error: 'db down' }]);
    });

    it('B-69 duplicateStrategy SKIP leaves an existing row untouched', async () => {
      repo.findByUsername.mockResolvedValue(makeDriver() as never);

      const summary = await service.importMany({ drivers: [baseDto], options: { duplicateStrategy: 'SKIP', sendInvitations: false, applyDefaultExemptions: false } });

      expect(summary).toEqual({ imported: 0, updated: 0, skipped: 1, failed: [] });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('B-69 duplicateStrategy CREATE fails a known username instead of upserting', async () => {
      repo.findByUsername.mockResolvedValue(makeDriver() as never);

      const summary = await service.importMany({ drivers: [baseDto], options: { duplicateStrategy: 'CREATE', sendInvitations: false, applyDefaultExemptions: false } });

      expect(summary.failed).toHaveLength(1);
      expect(repo.update).not.toHaveBeenCalled();
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('B-69 applyDefaultExemptions turns on the standard exception set for new rows', async () => {
      repo.findByUsername.mockResolvedValue(null);
      repo.create.mockResolvedValue(makeDriver() as never);

      await service.importMany({ drivers: [baseDto], options: { duplicateStrategy: 'UPDATE', applyDefaultExemptions: true, sendInvitations: false } });

      const [createArg] = repo.create.mock.calls[0] as [{ allowPersonalConveyance: boolean; allowYardMove: boolean }];
      expect(createArg.allowPersonalConveyance).toBe(true);
      expect(createArg.allowYardMove).toBe(true);
    });
  });
});
