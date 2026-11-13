import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { createTokenService } from './tokens';

const SECRET = 'unit-test-secret-0123456789-abcdefghijklmnop';
const USER = '0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b';
const COMPANY = '0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5c';
const key = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('access tokens', () => {
  const tokens = createTokenService(SECRET, 900);

  it('round-trips identity claims only', async () => {
    const { token } = await tokens.sign({ userId: USER, companyId: COMPANY });
    expect(await tokens.verify(token)).toEqual({ userId: USER, companyId: COMPANY });
  });

  it('expires after the configured lifetime', async () => {
    const issuedAt = new Date(Date.now() - 16 * 60_000);
    const { token, expiresAt } = await tokens.sign({ userId: USER, companyId: COMPANY }, issuedAt);
    expect(expiresAt.getTime()).toBe(Math.floor(issuedAt.getTime() / 1000) * 1000 + 900_000);
    expect(await tokens.verify(token)).toBeNull();
  });

  it('is still valid just before expiry', async () => {
    const issuedAt = new Date(Date.now() - 14 * 60_000);
    const { token } = await tokens.sign({ userId: USER, companyId: COMPANY }, issuedAt);
    expect(await tokens.verify(token)).not.toBeNull();
  });

  it('rejects a token signed with another secret', async () => {
    const other = createTokenService('another-secret-0123456789-abcdefghijklmnopq', 900);
    const { token } = await other.sign({ userId: USER, companyId: COMPANY });
    expect(await tokens.verify(token)).toBeNull();
  });

  it('rejects a tampered payload', async () => {
    const { token } = await tokens.sign({ userId: USER, companyId: COMPANY });
    const [h, p, s] = token.split('.') as [string, string, string];
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>;
    payload['cid'] = '0191a2b3-c4d5-7e6f-8a9b-ffffffffffff';
    const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}`;
    expect(await tokens.verify(forged)).toBeNull();
  });

  it('rejects alg=none', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({
        sub: USER,
        cid: COMPANY,
        iss: 'inventory-audit',
        aud: 'inventory-audit:company-api',
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
    ).toString('base64url');
    expect(await tokens.verify(`${header}.${body}.`)).toBeNull();
  });

  it('rejects a token for another audience (e.g. a future platform-admin token)', async () => {
    const token = await new SignJWT({ cid: COMPANY })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(USER)
      .setIssuer('inventory-audit')
      .setAudience('inventory-audit:platform')
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(key(SECRET));
    expect(await tokens.verify(token)).toBeNull();
  });

  it('rejects another issuer', async () => {
    const token = await new SignJWT({ cid: COMPANY })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(USER)
      .setIssuer('someone-else')
      .setAudience('inventory-audit:company-api')
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(key(SECRET));
    expect(await tokens.verify(token)).toBeNull();
  });

  it('rejects a different HMAC algorithm', async () => {
    const token = await new SignJWT({ cid: COMPANY })
      .setProtectedHeader({ alg: 'HS512' })
      .setSubject(USER)
      .setIssuer('inventory-audit')
      .setAudience('inventory-audit:company-api')
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(key(SECRET));
    expect(await tokens.verify(token)).toBeNull();
  });

  it('rejects claims that are not UUIDs', async () => {
    const mk = (sub: string, cid: string): Promise<string> =>
      new SignJWT({ cid })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(sub)
        .setIssuer('inventory-audit')
        .setAudience('inventory-audit:company-api')
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(key(SECRET));
    expect(await tokens.verify(await mk('admin', COMPANY))).toBeNull();
    expect(await tokens.verify(await mk(USER, "1' OR '1'='1"))).toBeNull();
  });

  it.each([[''], ['abc'], ['a.b.c'], ['Bearer x'], ['....']])(
    'returns null for garbage %j without throwing',
    async (garbage) => {
      expect(await tokens.verify(garbage)).toBeNull();
    },
  );
});
