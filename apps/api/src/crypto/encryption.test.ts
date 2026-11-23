import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createFieldCrypto, parseEncryptionKeys } from './encryption';

const k1 = randomBytes(32);
const k2 = randomBytes(32);
const mk = (id: string, ...all: Array<[string, Buffer]>) =>
  createFieldCrypto({ keys: new Map(all), currentKeyId: id });

describe('field encryption', () => {
  const c = mk('k1', ['k1', k1]);

  it('round-trips and never stores plaintext', () => {
    const enc = c.encrypt('JBSWY3DPEHPK3PXP', 'ctx');
    expect(enc).not.toContain('JBSWY3DPEHPK3PXP');
    expect(enc.startsWith('v1:k1:')).toBe(true);
    expect(c.decrypt(enc, 'ctx')).toBe('JBSWY3DPEHPK3PXP');
  });

  it('uses a fresh IV each time', () => {
    expect(c.encrypt('x', 'ctx')).not.toBe(c.encrypt('x', 'ctx'));
  });

  it('refuses a different context (a ciphertext cannot be moved to another row)', () => {
    expect(() => c.decrypt(c.encrypt('x', 'row-1'), 'row-2')).toThrow();
  });

  it('detects tampering', () => {
    const parts = c.encrypt('secret', 'ctx').split(':');
    parts[3] = Buffer.from('AAAAAA').toString('base64url');
    expect(() => c.decrypt(parts.join(':'), 'ctx')).toThrow();
  });

  it.each([[''], ['junk'], ['v2:k1:a:b:c'], ['v1:k1:a:b:c:d']])('rejects malformed %j', (p) => {
    expect(() => c.decrypt(p, 'ctx')).toThrow();
  });

  it('supports rotation: new key encrypts, the old key still decrypts', () => {
    const old = mk('k1', ['k1', k1]).encrypt('keep', 'ctx');
    const rotated = mk('k2', ['k1', k1], ['k2', k2]);
    expect(rotated.decrypt(old, 'ctx')).toBe('keep');
    expect(rotated.encrypt('new', 'ctx').startsWith('v1:k2:')).toBe(true);
    expect(() => mk('k2', ['k2', k2]).decrypt(old, 'ctx')).toThrow(/Unknown encryption key/);
  });
});

describe('parseEncryptionKeys', () => {
  const b64 = (b: Buffer): string => b.toString('base64');

  it('parses several keys and the current id', () => {
    const r = parseEncryptionKeys(`k1:${b64(k1)},k2:${b64(k2)}`, 'k2');
    expect(r.errors).toEqual([]);
    expect(r.value?.keys.size).toBe(2);
  });

  it.each([
    [undefined, 'k1'],
    ['', 'k1'],
    [`k1:${b64(randomBytes(16))}`, 'k1'],
    [`k1:${b64(Buffer.alloc(32, 1))}`, 'k1'],
    [`k1:${b64(k1)}`, 'missing'],
    [`k1:${b64(k1)}`, undefined],
    [`K 1:${b64(k1)}`, 'k1'],
    [`k1:${b64(k1)},k1:${b64(k2)}`, 'k1'],
  ])('rejects %j / %j', (raw, id) => {
    const r = parseEncryptionKeys(raw as string | undefined, id);
    expect(r.value).toBeNull();
    expect(r.errors.length).toBeGreaterThan(0);
  });
});
