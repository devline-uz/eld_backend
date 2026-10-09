import { MaintenanceSubmitDto } from './dto/mobile-maintenance.dto';
import { SignatureUploadDto } from './dto/mobile.dto';

const CLIENT_ID = '7d1c2a40-0000-4000-8000-000000000001';
const base = { invoiceNumber: 'INV-1', vendorName: 'Shop', cost: 10, clientId: CLIENT_ID };

describe('MaintenanceSubmitDto', () => {
  it('accepts numbers and decimal strings with at most 2 decimals', () => {
    expect(MaintenanceSubmitDto.parse(base).cost).toBe(10);
    expect(MaintenanceSubmitDto.parse({ ...base, cost: '412.50' }).cost).toBe(412.5);
    expect(MaintenanceSubmitDto.parse({ ...base, cost: 0.1 + 0.2 - 0.3 + 12.34 }).cost).toBeCloseTo(12.34);
  });

  it.each([-1, 10_000_000, '1.234', 'abc', 1.005])('rejects cost %p', (cost) => {
    expect(MaintenanceSubmitDto.safeParse({ ...base, cost }).success).toBe(false);
  });

  it('requires invoiceNumber, vendorName, cost and a UUID clientId', () => {
    expect(MaintenanceSubmitDto.safeParse({ ...base, clientId: 'nope' }).success).toBe(false);
    expect(MaintenanceSubmitDto.safeParse({ ...base, invoiceNumber: ' ' }).success).toBe(false);
    expect(MaintenanceSubmitDto.safeParse({ vendorName: 'x', cost: 1, clientId: CLIENT_ID }).success).toBe(false);
  });
});

describe('SignatureUploadDto (M-39 INVOICE)', () => {
  const b64 = 'JVBERi0xLjQKJcfsj6IK';
  it('accepts INVOICE with application/pdf', () => {
    expect(SignatureUploadDto.safeParse({ purpose: 'INVOICE', base64: b64, mimeType: 'application/pdf' }).success).toBe(true);
  });
  it('rejects application/pdf for any other purpose', () => {
    expect(SignatureUploadDto.safeParse({ purpose: 'DVIR_PHOTO', base64: b64, mimeType: 'application/pdf' }).success).toBe(false);
    expect(SignatureUploadDto.safeParse({ purpose: 'CERTIFICATION', base64: b64, mimeType: 'application/pdf' }).success).toBe(false);
  });
  it('keeps the PNG default', () => {
    expect(SignatureUploadDto.parse({ purpose: 'DVIR', base64: b64 }).mimeType).toBe('image/png');
  });
});
