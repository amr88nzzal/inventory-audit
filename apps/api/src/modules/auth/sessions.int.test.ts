import request from 'supertest';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { createTestDb, seedCompany, seedLoginUser } from '../../testing/test-db';
import type { TestDb } from '../../testing/test-db';
import { testConfig } from '../../testing/test-config';
import { generateRefreshToken, parseRefreshToken } from './sessions';

const PASSWORD = 'correct-horse-battery-9';

let t: TestDb;
let acme: string;
let globex: string;
let app: ReturnType<typeof createApp>;
let n = 0;

const freshUser = async (company = acme): Promise<string> => {
  const username = `sess${++n}`;
  await seedLoginUser(t.db, company, username, PASSWORD, { mustChangePassword: false });
  return username;
};

// عميل موبايل: التوكن في الجسم. Mobile client: token in the body.
const mobileLogin = async (
  username: string,
  code = 'acme',
): Promise<{ access: string; refresh: string }> => {
  const res = await request(app)
    .post('/api/v1/auth/login')
    .set('X-Client', 'mobile')
    .send({ companyCode: code, username, password: PASSWORD });
  expect(res.status).toBe(200);
  return { access: res.body.data.accessToken, refresh: res.body.data.refreshToken };
};

const mobileRefresh = (refreshToken: string): request.Test =>
  request(app).post('/api/v1/auth/refresh').set('X-Client', 'mobile').send({ refreshToken });

const me = (access: string): request.Test =>
  request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${access}`);

beforeAll(async () => {
  t = await createTestDb();
  acme = await seedCompany(t.db, 'Acme', 'acme');
  globex = await seedCompany(t.db, 'Globex', 'globex');
  app = createApp({ db: t.db, config: testConfig() });
});

afterAll(async () => {
  await t.cleanup();
});

describe('refresh token format', () => {
  it('generates and parses round-trip, storing only a hash', () => {
    const { token, hash } = generateRefreshToken(acme);
    const parsed = parseRefreshToken(token);
    expect(parsed).toEqual({ companyId: acme, hash });
    expect(token).not.toContain(hash);
  });

  it.each([[undefined], [''], ['x'], ['a.b'], [`${'1'.repeat(8)}.x`], [123], ['a.b.c']])(
    'rejects malformed %j',
    (raw) => {
      expect(parseRefreshToken(raw)).toBeNull();
    },
  );
});

describe('rotation', () => {
  it('login returns a refresh token (mobile) and refresh issues a new pair', async () => {
    const { refresh } = await mobileLogin(await freshUser());
    const res = await mobileRefresh(refresh);
    expect(res.status).toBe(200);
    expect(res.body.data.refreshToken).not.toBe(refresh);
    expect((await me(res.body.data.accessToken)).status).toBe(200);
  });

  it('web: refresh token is an httpOnly cookie and never in the body', async () => {
    const username = await freshUser();
    const agent = request.agent(app);
    const login = await agent
      .post('/api/v1/auth/login')
      .send({ companyCode: 'acme', username, password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.data.refreshToken).toBeUndefined();
    const cookie = String(login.headers['set-cookie']);
    expect(cookie).toMatch(/refresh_token=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);

    const res = await agent.post('/api/v1/auth/refresh').send({});
    expect(res.status).toBe(200);
    expect(res.body.data.refreshToken).toBeUndefined();
    expect(String(res.headers['set-cookie'])).toMatch(/refresh_token=/);
  });

  it('web: a refresh token in the body is ignored (cookie only)', async () => {
    const { refresh } = await mobileLogin(await freshUser());
    const res = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: refresh });
    expect(res.status).toBe(401);
  });

  it('answers 401 INVALID_REFRESH_TOKEN for missing, forged or foreign-company tokens', async () => {
    const username = await freshUser();
    const { refresh } = await mobileLogin(username);
    const secret = refresh.split('.')[1]!;
    for (const bad of [
      '',
      'garbage',
      generateRefreshToken(acme).token,
      `${globex}.${secret}`, // سر صحيح مع شركة أخرى: لا يُرى بسبب RLS. A valid secret under another company: invisible via RLS.
    ]) {
      const res = await mobileRefresh(bad);
      expect(res.status, bad).toBe(401);
      expect(res.body.error.code).toBe('INVALID_REFRESH_TOKEN');
    }
  });

  it('reuse of a consumed token revokes the whole family, including the newest token', async () => {
    const { access, refresh: first } = await mobileLogin(await freshUser());
    const second = (await mobileRefresh(first)).body.data.refreshToken as string;

    const reuse = await mobileRefresh(first);
    expect(reuse.status).toBe(401);

    // التوكن الجديد (الشرعي) صار باطلاً أيضاً، وتوكن الوصول القديم كذلك.
    // The newer (legitimate) token is dead too, and so is the earlier access token.
    expect((await mobileRefresh(second)).status).toBe(401);
    expect((await me(access)).status).toBe(401);
  });

  it('concurrent use of one token: exactly one wins', async () => {
    const { refresh } = await mobileLogin(await freshUser());
    const results = await Promise.all(Array.from({ length: 5 }, () => mobileRefresh(refresh)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it('refuses to refresh after the user is disabled', async () => {
    const username = await freshUser();
    const { refresh } = await mobileLogin(username);
    await sql`UPDATE users SET active = false WHERE company_id = ${acme} AND username = ${username}`.execute(
      t.db,
    );
    expect((await mobileRefresh(refresh)).status).toBe(401);
  });

  it('refuses expired refresh tokens and sessions past their absolute lifetime', async () => {
    const a = await mobileLogin(await freshUser());
    await sql`UPDATE refresh_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = ${parseRefreshToken(a.refresh)!.hash}`.execute(
      t.db,
    );
    expect((await mobileRefresh(a.refresh)).status).toBe(401);

    const b = await mobileLogin(await freshUser());
    await sql`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id IN (SELECT session_id FROM refresh_tokens WHERE token_hash = ${parseRefreshToken(b.refresh)!.hash})`.execute(
      t.db,
    );
    expect((await mobileRefresh(b.refresh)).status).toBe(401);
    expect((await me(b.access)).status).toBe(401);
  });

  it('never extends a refresh token past the session absolute expiry', async () => {
    const { refresh } = await mobileLogin(await freshUser());
    await sql`UPDATE sessions SET expires_at = now() + interval '1 day' WHERE id IN (SELECT session_id FROM refresh_tokens WHERE token_hash = ${parseRefreshToken(refresh)!.hash})`.execute(
      t.db,
    );
    const res = await mobileRefresh(refresh);
    const exp = new Date(res.body.data.refreshExpiresAt as string).getTime();
    expect(exp).toBeLessThanOrEqual(Date.now() + 86_400_000 + 5000);
  });
});

describe('logout and revocation', () => {
  it('logout needs only the refresh token, kills it and the access token, and is idempotent', async () => {
    const { access, refresh } = await mobileLogin(await freshUser());
    const out = await request(app)
      .post('/api/v1/auth/logout')
      .set('X-Client', 'mobile')
      .send({ refreshToken: refresh });
    expect(out.status).toBe(200);
    expect((await mobileRefresh(refresh)).status).toBe(401);
    expect((await me(access)).status).toBe(401);

    for (const body of [{ refreshToken: refresh }, { refreshToken: 'junk' }, {}]) {
      const again = await request(app)
        .post('/api/v1/auth/logout')
        .set('X-Client', 'mobile')
        .send(body);
      expect(again.status).toBe(200);
    }
  });

  it('logout of one session leaves the same user’s other sessions alone', async () => {
    const username = await freshUser();
    const a = await mobileLogin(username);
    const b = await mobileLogin(username);
    await request(app)
      .post('/api/v1/auth/logout')
      .set('X-Client', 'mobile')
      .send({ refreshToken: a.refresh });
    expect((await me(a.access)).status).toBe(401);
    expect((await me(b.access)).status).toBe(200);
  });

  it('logout-all revokes every session of the user, and only that user’s', async () => {
    const username = await freshUser();
    const other = await mobileLogin(await freshUser());
    const a = await mobileLogin(username);
    const b = await mobileLogin(username);
    const res = await request(app)
      .post('/api/v1/auth/logout-all')
      .set('Authorization', `Bearer ${a.access}`);
    expect(res.status).toBe(200);
    expect((await me(a.access)).status).toBe(401);
    expect((await me(b.access)).status).toBe(401);
    expect((await mobileRefresh(b.refresh)).status).toBe(401);
    expect((await me(other.access)).status).toBe(200);
  });

  it('changing the password revokes the other sessions but keeps the current one', async () => {
    const username = await freshUser();
    const current = await mobileLogin(username);
    const stolen = await mobileLogin(username);
    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${current.access}`)
      .send({ currentPassword: PASSWORD, newPassword: 'a-brand-new-passphrase-1' });
    expect(res.status).toBe(200);
    expect((await me(current.access)).status).toBe(200);
    expect((await me(stolen.access)).status).toBe(401);
    expect((await mobileRefresh(stolen.refresh)).status).toBe(401);
  });

  it('logout-all requires authentication', async () => {
    expect((await request(app).post('/api/v1/auth/logout-all')).status).toBe(401);
  });
});

describe('tenant isolation of sessions', () => {
  it('a company cannot read or revoke another company’s sessions through RLS', async () => {
    const a = await mobileLogin(await freshUser(acme));
    const g = await mobileLogin(await freshUser(globex), 'globex');
    const { withTenant } = await import('../../db');
    const seen = await withTenant(t.db, { companyId: globex }, ({ trx }) =>
      trx.selectFrom('sessions').select('company_id').execute(),
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.company_id === globex)).toBe(true);
    const touched = await withTenant(t.db, { companyId: globex }, ({ trx }) =>
      trx
        .updateTable('sessions')
        .set({ revoked_at: new Date() })
        .where('company_id', '=', acme)
        .returning('id')
        .execute(),
    );
    expect(touched).toHaveLength(0);
    expect((await me(a.access)).status).toBe(200);
    expect((await me(g.access)).status).toBe(200);
  });
});
