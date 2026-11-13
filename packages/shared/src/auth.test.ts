import { describe, expect, it } from 'vitest';
import { changePasswordSchema, companyCodeSchema, loginSchema } from './auth';

describe('companyCodeSchema', () => {
  it('normalizes case and surrounding whitespace', () => {
    expect(companyCodeSchema.parse('  ACME-Trading  ')).toBe('acme-trading');
  });

  it.each(['ab', 'a', '-acme', 'acme-', 'ac me', 'acme_corp', 'شركة', '', 'a'.repeat(33)])(
    'rejects %j',
    (bad) => {
      expect(companyCodeSchema.safeParse(bad).success).toBe(false);
    },
  );

  it.each(['abc', 'a1b', 'acme-1', 'a'.repeat(32)])('accepts %j', (ok) => {
    expect(companyCodeSchema.safeParse(ok).success).toBe(true);
  });
});

describe('loginSchema', () => {
  const valid = { companyCode: 'Acme', username: ' amro ', password: 'x' };

  it('parses and normalizes', () => {
    expect(loginSchema.parse(valid)).toEqual({
      companyCode: 'acme',
      username: 'amro',
      password: 'x',
    });
  });

  it('rejects unknown keys (no mass assignment)', () => {
    expect(loginSchema.safeParse({ ...valid, companyId: 'x' }).success).toBe(false);
  });

  it('rejects missing or non-string fields', () => {
    expect(loginSchema.safeParse({ ...valid, password: undefined }).success).toBe(false);
    expect(loginSchema.safeParse({ ...valid, username: 123 }).success).toBe(false);
    expect(loginSchema.safeParse({ ...valid, username: '   ' }).success).toBe(false);
  });

  it('caps the password length', () => {
    expect(loginSchema.safeParse({ ...valid, password: 'x'.repeat(257) }).success).toBe(false);
  });
});

describe('changePasswordSchema', () => {
  it('requires a new password of at least 12 characters', () => {
    expect(
      changePasswordSchema.safeParse({ currentPassword: 'old', newPassword: 'short' }).success,
    ).toBe(false);
    expect(
      changePasswordSchema.safeParse({ currentPassword: 'old', newPassword: 'a-long-enough-one' })
        .success,
    ).toBe(true);
  });

  it('rejects a new password equal to the current one', () => {
    const r = changePasswordSchema.safeParse({
      currentPassword: 'a-long-enough-one',
      newPassword: 'a-long-enough-one',
    });
    expect(r.success).toBe(false);
  });

  it('caps the new password length', () => {
    expect(
      changePasswordSchema.safeParse({ currentPassword: 'o', newPassword: 'x'.repeat(129) })
        .success,
    ).toBe(false);
  });
});
