const send = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send })),
  PutObjectCommand: jest.fn().mockImplementation((input: unknown) => ({ input, __type: 'Put' })),
  GetObjectCommand: jest.fn().mockImplementation((input: unknown) => ({ input, __type: 'Get' })),
  DeleteObjectCommand: jest.fn().mockImplementation((input: unknown) => ({ input, __type: 'Delete' })),
  HeadObjectCommand: jest.fn().mockImplementation((input: unknown) => ({ input, __type: 'Head' })),
}));

const getSignedUrl = jest.fn();
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]): unknown => getSignedUrl(...args),
}));

import { S3StorageService } from './s3-storage.service';
import { AppException } from '../../common/errors/app.exception';

function makeConfig(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    S3_BUCKET: 'onebook-eld',
    S3_KEY_PREFIX: '',
    S3_PRESIGN_TTL_SEC: 900,
    S3_ACCESS_KEY: 'AKIA',
    S3_SECRET_KEY: 'secret',
    S3_REGION: 'us-east-1',
    S3_ENDPOINT: 'http://minio:9000',
    S3_FORCE_PATH_STYLE: true,
    ...overrides,
  };
  return { get: (key: string) => values[key] };
}

describe('S3StorageService', () => {
  beforeEach(() => {
    send.mockReset();
    getSignedUrl.mockReset();
  });

  it('put() writes through PutObjectCommand and returns the final key', async () => {
    const service = new S3StorageService(makeConfig() as never);
    send.mockResolvedValue({});
    const key = await service.put('reports/x.pdf', Buffer.from('data'), { contentType: 'application/pdf' });
    expect(key).toBe('reports/x.pdf');
    expect(send).toHaveBeenCalled();
  });

  it('put() prefixes the key when S3_KEY_PREFIX is set (trailing slash stripped)', async () => {
    const service = new S3StorageService(makeConfig({ S3_KEY_PREFIX: 'tenant-a/' }) as never);
    send.mockResolvedValue({});
    const key = await service.put('reports/x.pdf', Buffer.from('data'));
    expect(key).toBe('tenant-a/reports/x.pdf');
  });

  it('get() returns the object body as a Buffer', async () => {
    const service = new S3StorageService(makeConfig() as never);
    send.mockResolvedValue({ Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } });
    const buf = await service.get('reports/x.pdf');
    expect(buf).toEqual(Buffer.from([1, 2, 3]));
  });

  it('get() throws STORAGE_UNAVAILABLE when the response has no Body', async () => {
    const service = new S3StorageService(makeConfig() as never);
    send.mockResolvedValue({});
    await expect(service.get('missing.pdf')).rejects.toThrow(AppException);
  });

  it('delete() sends a DeleteObjectCommand', async () => {
    const service = new S3StorageService(makeConfig() as never);
    send.mockResolvedValue({});
    await service.delete('reports/x.pdf');
    expect(send).toHaveBeenCalled();
  });

  describe('exists()', () => {
    it('returns true when HeadObjectCommand succeeds', async () => {
      const service = new S3StorageService(makeConfig() as never);
      send.mockResolvedValue({});
      await expect(service.exists('reports/x.pdf')).resolves.toBe(true);
    });

    it('returns false when HeadObjectCommand throws (object missing)', async () => {
      const service = new S3StorageService(makeConfig() as never);
      send.mockRejectedValue(new Error('NotFound'));
      await expect(service.exists('reports/missing.pdf')).resolves.toBe(false);
    });
  });

  it('presignPut() uses the given ttl, falling back to the default', async () => {
    const service = new S3StorageService(makeConfig() as never);
    getSignedUrl.mockResolvedValue('https://signed-put-url');
    const url = await service.presignPut('reports/x.pdf', 'application/pdf', 120);
    expect(url).toBe('https://signed-put-url');
    expect(getSignedUrl).toHaveBeenCalledWith(expect.anything(), expect.anything(), { expiresIn: 120, signableHeaders: new Set(['content-type']) });
  });

  it('B-091 — presignPut() signs content-type and content-length so the upload cannot swap either', async () => {
    const service = new S3StorageService(makeConfig() as never);
    getSignedUrl.mockResolvedValue('https://signed-put-url');
    await service.presignPut('driver-documents/d/x.pdf', 'application/pdf', 900, 2048);
    const [, command, options] = getSignedUrl.mock.calls.at(-1) as [unknown, { input: Record<string, unknown> }, { signableHeaders: Set<string> }];
    expect(command.input).toMatchObject({ ContentType: 'application/pdf', ContentLength: 2048 });
    expect([...options.signableHeaders].sort()).toEqual(['content-length', 'content-type']);
  });

  it('presignGet() falls back to the configured default ttl when none is given', async () => {
    const service = new S3StorageService(makeConfig({ S3_PRESIGN_TTL_SEC: 300 }) as never);
    getSignedUrl.mockResolvedValue('https://signed-get-url');
    await service.presignGet('reports/x.pdf');
    expect(getSignedUrl).toHaveBeenCalledWith(expect.anything(), expect.anything(), { expiresIn: 300 });
  });

  it('ping() presigns a health-check GET and returns true', async () => {
    const service = new S3StorageService(makeConfig() as never);
    getSignedUrl.mockResolvedValue('https://signed-health-url');
    await expect(service.ping()).resolves.toBe(true);
  });

  it('constructs without static credentials when access/secret keys are absent', () => {
    expect(() => new S3StorageService(makeConfig({ S3_ACCESS_KEY: undefined, S3_SECRET_KEY: undefined }) as never)).not.toThrow();
  });
});
