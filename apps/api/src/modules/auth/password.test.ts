import { describe, expect, it } from 'vitest';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './password';

const LOG_N = 10;

describe('password hashing', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const stored = await hashPassword('correct horse battery', LOG_N);
    expect(await verifyPassword('correct horse battery', stored)).toBe(true);
    expect(await verifyPassword('correct horse batterz', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('uses a random salt: the same password hashes differently each time', async () => {
    const a = await hashPassword('same-password-123', LOG_N);
    const b = await hashPassword('same-password-123', LOG_N);
    expect(a).not.toBe(b);
    expect(await verifyPassword('same-password-123', a)).toBe(true);
    expect(await verifyPassword('same-password-123', b)).toBe(true);
  });

  it('stores its parameters, so a hash made at another cost still verifies', async () => {
    const stored = await hashPassword('portable-password', 11);
    expect(stored.startsWith('scrypt$11$8$1$')).toBe(true);
    expect(await verifyPassword('portable-password', stored)).toBe(true);
  });

  it('never contains the plaintext', async () => {
    const stored = await hashPassword('plaintext-marker-xyz', LOG_N);
    expect(stored).not.toContain('plaintext-marker-xyz');
  });

  it('handles unicode and long passwords', async () => {
    const pw = 'كلمة-مرور-عربية-طويلة-🔐-'.repeat(5);
    const stored = await hashPassword(pw, LOG_N);
    expect(await verifyPassword(pw, stored)).toBe(true);
    expect(await verifyPassword(pw + 'x', stored)).toBe(false);
  });

  it.each([
    [''],
    ['not-a-hash'],
    ['scrypt$10$8$1$onlyfive'],
    ['bcrypt$10$8$1$c2FsdA$aGFzaA'],
    ['scrypt$abc$8$1$c2FsdA$aGFzaA'],
    ['scrypt$30$8$1$c2FsdA$aGFzaA'],
    ['scrypt$10$0$1$c2FsdA$aGFzaA'],
    ['scrypt$10$8$99$c2FsdA$aGFzaA'],
    ['scrypt$10$8$1$$aGFzaA'],
    ['scrypt$10$8$1$c2FsdA$'],
  ])('returns false (never throws) for a malformed stored value: %j', async (bad) => {
    await expect(verifyPassword('anything', bad)).resolves.toBe(false);
  });

  it('rejects a hash of the right shape but different length', async () => {
    const stored = await hashPassword('length-check-pw', LOG_N);
    const truncated = stored.slice(0, -8);
    expect(await verifyPassword('length-check-pw', truncated)).toBe(false);
  });

  it('refuses out-of-range costs when hashing', async () => {
    await expect(hashPassword('x', 5)).rejects.toThrow(RangeError);
    await expect(hashPassword('x', 25)).rejects.toThrow(RangeError);
  });

  it('verifyAgainstDummy completes without throwing', async () => {
    await expect(verifyAgainstDummy('whatever', LOG_N)).resolves.toBeUndefined();
  });
});
