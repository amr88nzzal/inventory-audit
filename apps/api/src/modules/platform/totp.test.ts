import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  otpauthUri,
  stepAt,
  totpAt,
  verifyTotp,
} from './totp';

// متجهات RFC 6238 الرسمية (SHA-1، السر 12345678901234567890).
// The official RFC 6238 vectors (SHA-1, secret 12345678901234567890).
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('TOTP', () => {
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('matches the RFC 6238 vector at t=%i', (t, expected8) => {
    expect(totpAt(RFC_SECRET, t * 1000, 8)).toBe(expected8);
    expect(totpAt(RFC_SECRET, t * 1000, 6)).toBe(expected8.slice(2));
  });

  it('base32 round-trips and rejects invalid characters', () => {
    const raw = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(base32Decode(base32Encode(raw))).toEqual(raw);
    expect(() => base32Decode('abc1')).toThrow();
    expect(generateTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
    expect(generateTotpSecret()).not.toBe(generateTotpSecret());
  });

  const now = 1_700_000_000_000;
  const code = (offsetSteps: number): string => totpAt(RFC_SECRET, now + offsetSteps * 30_000);

  it('accepts the current code and one step either side, but not two', () => {
    expect(verifyTotp(RFC_SECRET, code(0), now, null)).toBe(stepAt(now));
    expect(verifyTotp(RFC_SECRET, code(-1), now, null)).toBe(stepAt(now) - 1);
    expect(verifyTotp(RFC_SECRET, code(1), now, null)).toBe(stepAt(now) + 1);
    expect(verifyTotp(RFC_SECRET, code(-2), now, null)).toBeNull();
    expect(verifyTotp(RFC_SECRET, code(2), now, null)).toBeNull();
  });

  it('refuses a replay: a step at or before the last accepted one', () => {
    const step = stepAt(now);
    expect(verifyTotp(RFC_SECRET, code(0), now, step)).toBeNull();
    expect(verifyTotp(RFC_SECRET, code(-1), now, step)).toBeNull();
    expect(verifyTotp(RFC_SECRET, code(1), now, step)).toBe(step + 1);
  });

  it.each([[''], ['12345'], ['1234567'], ['abcdef'], ['12 456'], [' 123456']])(
    'rejects a malformed code %j',
    (bad) => {
      expect(verifyTotp(RFC_SECRET, bad, now, null)).toBeNull();
    },
  );

  it('builds an otpauth URI authenticator apps understand', () => {
    const uri = otpauthUri('Inventory Audit', 'root@platform', RFC_SECRET);
    expect(uri.startsWith('otpauth://totp/Inventory%20Audit:root%40platform?')).toBe(true);
    expect(uri).toContain(`secret=${RFC_SECRET}`);
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });
});
