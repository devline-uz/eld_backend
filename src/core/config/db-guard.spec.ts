import { assertDatabaseTarget } from './db-guard';

const dev = 'postgresql://eld_dev:pw@localhost:5432/onebook_eld_dev';
const prod = 'postgresql://eld_prod:pw@localhost:5432/onebook_eld';
const test = 'postgresql://eld_test:pw@localhost:5432/onebook_eld_test';

describe('db-guard (TZ §22.3.4)', () => {
  it('accepts dev env on dev DB', () => {
    expect(() =>
      assertDatabaseTarget({ DATABASE_URL: dev, NODE_ENV: 'development' }),
    ).not.toThrow();
  });

  it('accepts prod env on prod DB with the prod user', () => {
    expect(() => assertDatabaseTarget({ DATABASE_URL: prod, NODE_ENV: 'production' })).not.toThrow();
  });

  it('rejects an unknown database name', () => {
    expect(() =>
      assertDatabaseTarget({
        DATABASE_URL: 'postgresql://x:y@h:5432/something_else',
        NODE_ENV: 'development',
      }),
    ).toThrow(/noma'lum DB nomi/);
  });

  it('rejects dev env pointed at the prod DB', () => {
    expect(() => assertDatabaseTarget({ DATABASE_URL: prod, NODE_ENV: 'development' })).toThrow(
      /dev rejimi PROD DB/,
    );
  });

  it('rejects prod env pointed at the dev DB', () => {
    expect(() => assertDatabaseTarget({ DATABASE_URL: dev, NODE_ENV: 'production' })).toThrow(
      /prod rejimi DEV DB/,
    );
  });

  it('rejects prod env connecting with a non-prod DB user', () => {
    expect(() =>
      assertDatabaseTarget({
        DATABASE_URL: 'postgresql://eld_dev:pw@h:5432/onebook_eld',
        NODE_ENV: 'production',
      }),
    ).toThrow(/DB foydalanuvchisi/);
  });

  // D-105 — dedicated onebook_eld_test DB, only ever valid under NODE_ENV=test.
  it('accepts test env on the dedicated test DB', () => {
    expect(() => assertDatabaseTarget({ DATABASE_URL: test, NODE_ENV: 'test' })).not.toThrow();
  });

  it('rejects prod env pointed at the test DB', () => {
    expect(() => assertDatabaseTarget({ DATABASE_URL: test, NODE_ENV: 'production' })).toThrow(
      /prod rejimi TEST DB/,
    );
  });

  it('rejects test env pointed at the dev DB', () => {
    expect(() => assertDatabaseTarget({ DATABASE_URL: dev, NODE_ENV: 'test' })).toThrow(
      /NODE_ENV=test faqat TEST DB/,
    );
  });

  it('rejects a test-env-labelled connection to a non-test DB name', () => {
    expect(() => assertDatabaseTarget({ DATABASE_URL: test, NODE_ENV: 'development' })).toThrow(
      /TEST DB faqat NODE_ENV=test/,
    );
  });
});
