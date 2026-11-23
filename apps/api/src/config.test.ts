import { describe, expect, it } from 'vitest';
import { isWeakSecret, loadConfig } from './config';

const GOOD_SECRET = 'Xk9fQ2mWv7LpZr4TnB8cHy3JdUe6SaGo1MiNq5VtAw0';
const ENC_KEY = Buffer.from('0123456789abcdef0123456789ABCDEF').toString('base64');
const base = {
  DATABASE_URL: 'postgres://u:p@h:5432/d',
  JWT_SECRET: GOOD_SECRET,
  ENCRYPTION_KEYS: `k1:${ENC_KEY}`,
  ENCRYPTION_KEY_ID: 'k1',
};

describe('loadConfig', () => {
  it('loads defaults from a minimal valid environment', () => {
    const c = loadConfig({ ...base });
    expect(c).toMatchObject({
      nodeEnv: 'development',
      port: 3000,
      accessTokenTtlSeconds: 900,
      passwordHashLogN: 17,
      loginMaxFailures: 5,
      loginLockMinutes: 15,
      refreshTokenTtlDays: 30,
      sessionMaxDays: 90,
    });
  });

  it('requires DATABASE_URL and JWT_SECRET', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL is required/);
    expect(() => loadConfig({})).toThrow(/JWT_SECRET is required/);
  });

  it('rejects a short JWT_SECRET in every environment', () => {
    expect(() => loadConfig({ ...base, JWT_SECRET: 'short', NODE_ENV: 'development' })).toThrow(
      /at least 32/,
    );
  });

  it('rejects the old repo default and other placeholders in production', () => {
    for (const weak of [
      'super-secret-jwt-key-change-this-in-production',
      'change-me-change-me-change-me-change-me',
      'my-password-for-the-jwt-signing-key-xyz',
      'a'.repeat(40),
    ]) {
      expect(() => loadConfig({ ...base, JWT_SECRET: weak, NODE_ENV: 'production' })).toThrow(
        /placeholder|repetitive/,
      );
    }
  });

  it('allows a placeholder-looking secret outside production (local development)', () => {
    expect(() =>
      loadConfig({
        ...base,
        JWT_SECRET: 'dev-secret-key-for-local-use-only-1234567',
        NODE_ENV: 'development',
      }),
    ).not.toThrow();
  });

  it('accepts a random secret in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).not.toThrow();
  });

  it('enforces a minimum hash cost in production only', () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', PASSWORD_HASH_LOG_N: '12' }),
    ).toThrow(/at least 15/);
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'development', PASSWORD_HASH_LOG_N: '12' }),
    ).not.toThrow();
  });

  it('rejects out-of-range or non-numeric tunables', () => {
    expect(() => loadConfig({ ...base, PASSWORD_HASH_LOG_N: '30' })).toThrow(/between 10 and 20/);
    expect(() => loadConfig({ ...base, PORT: 'abc' })).toThrow(/PORT must be a positive integer/);
    expect(() => loadConfig({ ...base, LOGIN_MAX_FAILURES: '0' })).toThrow(/LOGIN_MAX_FAILURES/);
  });

  it('rejects a refresh lifetime longer than the absolute session lifetime', () => {
    expect(() =>
      loadConfig({ ...base, REFRESH_TOKEN_TTL_DAYS: '100', SESSION_MAX_DAYS: '90' }),
    ).toThrow(/must not exceed SESSION_MAX_DAYS/);
  });

  it('requires valid encryption keys', () => {
    const noKeys: Record<string, string> = { ...base };
    delete noKeys['ENCRYPTION_KEYS'];
    expect(() => loadConfig(noKeys)).toThrow(/ENCRYPTION_KEYS is required/);
    expect(() => loadConfig({ ...base, ENCRYPTION_KEY_ID: 'zz' })).toThrow(/must name a key/);
  });

  it('platform bootstrap credentials come as a pair and the password is long enough', () => {
    expect(() => loadConfig({ ...base, PLATFORM_ADMIN_USERNAME: 'root' })).toThrow(/set together/);
    expect(() =>
      loadConfig({ ...base, PLATFORM_ADMIN_USERNAME: 'root', PLATFORM_ADMIN_PASSWORD: 'short' }),
    ).toThrow(/at least 12/);
    const c = loadConfig({
      ...base,
      PLATFORM_ADMIN_USERNAME: 'root',
      PLATFORM_ADMIN_PASSWORD: 'a-long-enough-password',
    });
    expect(c.platform.bootstrap).toEqual({ username: 'root', password: 'a-long-enough-password' });
    expect(loadConfig(base).platform.bootstrap).toBeNull();
  });

  it('parses the platform IP allowlist', () => {
    expect(
      loadConfig({ ...base, PLATFORM_ALLOWED_IPS: '1.2.3.4, 5.6.7.8,' }).platform.allowedIps,
    ).toEqual(['1.2.3.4', '5.6.7.8']);
  });

  it('reports every problem at once', () => {
    expect(() => loadConfig({ PORT: 'x' })).toThrow(/DATABASE_URL[\s\S]*JWT_SECRET[\s\S]*PORT/);
  });
});

describe('isWeakSecret', () => {
  it('flags placeholders and low-variety strings', () => {
    expect(isWeakSecret('please-change-me-now-0000000000000000')).toBe(true);
    expect(isWeakSecret('abababababababababababababababababab')).toBe(true);
  });
  it('accepts high-entropy strings', () => {
    expect(isWeakSecret(GOOD_SECRET)).toBe(false);
  });
});
