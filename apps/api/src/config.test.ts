import { describe, expect, it } from 'vitest';
import { isWeakSecret, loadConfig } from './config';

const GOOD_SECRET = 'Xk9fQ2mWv7LpZr4TnB8cHy3JdUe6SaGo1MiNq5VtAw0';
const base = { DATABASE_URL: 'postgres://u:p@h:5432/d', JWT_SECRET: GOOD_SECRET };

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
