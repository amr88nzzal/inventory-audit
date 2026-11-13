import { Router } from 'express';
import request from 'supertest';
import { sql } from 'kysely';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app';
import { lookupCompanyId, newId } from '../../db';
import { createTestDb, seedCompany, seedLoginUser } from '../../testing/test-db';
import type { TestDb } from '../../testing/test-db';
import { testConfig } from '../../testing/test-config';
import { createTokenService } from './tokens';

const PASSWORD = 'correct-horse-battery-9';

let t: TestDb;
let acme: string;
let globex: string;
let app: ReturnType<typeof createApp>;
let n = 0;

// مسارات اختبارية محمية: تثبت أن أي وحدة أعمال تُركَّب تلقائياً بعد requireAuth.
// Protected test routes: they prove any business module is mounted behind requireAuth automatically.
const probe = Router();
probe.get('/secret', (_req, res) => {
  res.json({ data: { ok: true }, meta: {} });
});
probe.get('/boom', () => {
  throw new Error('connection to db with password=hunter2 failed');
});

const freshUser = async (
  options: { company?: string; mustChangePassword?: boolean; active?: boolean } = {},
): Promise<{ id: string; username: string }> => {
  const username = `user${++n}`;
  const id = await seedLoginUser(t.db, options.company ?? acme, username, PASSWORD, options);
  return { id, username };
};

const login = (body: Record<string, unknown>, target = app): request.Test =>
  request(target).post('/api/v1/auth/login').send(body);

const loginAs = async (username: string, code = 'acme'): Promise<string> => {
  const res = await login({ companyCode: code, username, password: PASSWORD });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
};

const bearer = (token: string): [string, string] => ['Authorization', `Bearer ${token}`];

beforeAll(async () => {
  t = await createTestDb();
  acme = await seedCompany(t.db, 'Acme Trading', 'acme');
  globex = await seedCompany(t.db, 'Globex', 'globex');
  app = createApp({ db: t.db, config: testConfig(), protectedRouters: [probe] });
});

afterAll(async () => {
  await t.cleanup();
});

describe('lookupCompanyId (login before any tenant context)', () => {
  it('finds a company by its exact code and nothing else', async () => {
    expect(await lookupCompanyId(t.db, 'acme')).toBe(acme);
    expect(await lookupCompanyId(t.db, 'globex')).toBe(globex);
    expect(await lookupCompanyId(t.db, 'nope')).toBeNull();
    expect(await lookupCompanyId(t.db, '')).toBeNull();
    expect(await lookupCompanyId(t.db, '%')).toBeNull();
  });

  it('exposes only the matching row: it cannot be used to list companies', async () => {
    const count = await t.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE inventory_app`.execute(trx);
      await sql`SELECT set_config('app.lookup_code', 'acme', true)`.execute(trx);
      return (await sql<{ n: string }>`SELECT count(*)::text AS n FROM companies`.execute(trx))
        .rows[0]?.n;
    });
    expect(count).toBe('1');
  });

  it('sees no company at all without a code or tenant context', async () => {
    const count = await t.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE inventory_app`.execute(trx);
      return (await sql<{ n: string }>`SELECT count(*)::text AS n FROM companies`.execute(trx))
        .rows[0]?.n;
    });
    expect(count).toBe('0');
  });

  it('does not find a soft-deleted company', async () => {
    const id = await seedCompany(t.db, 'Gone Ltd', 'gone-ltd');
    await t.db
      .updateTable('companies')
      .set({ deleted_at: new Date() })
      .where('id', '=', id)
      .execute();
    expect(await lookupCompanyId(t.db, 'gone-ltd')).toBeNull();
  });

  it('enforces the code format and uniqueness in the database', async () => {
    await expect(seedCompany(t.db, 'Bad', 'Has Space')).rejects.toMatchObject({ code: '23514' });
    await expect(seedCompany(t.db, 'Dup', 'acme')).rejects.toMatchObject({ code: '23505' });
  });
});

describe('POST /auth/login', () => {
  it('logs in with company code, username and password', async () => {
    const u = await freshUser();
    const res = await login({ companyCode: 'acme', username: u.username, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({});
    expect(res.body.data).toMatchObject({
      tokenType: 'Bearer',
      user: { id: u.id, companyId: acme, username: u.username, mustChangePassword: false },
    });
    const ttl = new Date(res.body.data.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(14 * 60_000);
    expect(ttl).toBeLessThanOrEqual(15 * 60_000);
    expect(JSON.stringify(res.body)).not.toMatch(/password_hash|scrypt\$/);

    const row = await t.db
      .selectFrom('users')
      .select('last_login_at')
      .where('id', '=', u.id)
      .executeTakeFirstOrThrow();
    expect(row.last_login_at).toBeInstanceOf(Date);
  });

  it('is case-insensitive for company code and username', async () => {
    const u = await freshUser();
    const res = await login({
      companyCode: '  ACME ',
      username: u.username.toUpperCase(),
      password: PASSWORD,
    });
    expect(res.status).toBe(200);
  });

  it('keeps companies apart: same username, different company, different identity', async () => {
    const a = await seedLoginUser(t.db, acme, 'shared-name', 'acme-password-123');
    const g = await seedLoginUser(t.db, globex, 'shared-name', 'globex-password-123');

    const ra = await login({
      companyCode: 'acme',
      username: 'shared-name',
      password: 'acme-password-123',
    });
    const rg = await login({
      companyCode: 'globex',
      username: 'shared-name',
      password: 'globex-password-123',
    });
    expect(ra.body.data.user).toMatchObject({ id: a, companyId: acme });
    expect(rg.body.data.user).toMatchObject({ id: g, companyId: globex });

    // كلمة مرور شركة لا تفتح حساب الأخرى.
    // One company's password does not open the other's account.
    const cross = await login({
      companyCode: 'globex',
      username: 'shared-name',
      password: 'acme-password-123',
    });
    expect(cross.status).toBe(401);

    const me = await request(app)
      .get('/api/v1/auth/me')
      .set(...bearer(ra.body.data.accessToken));
    expect(me.body.data).toMatchObject({ id: a, companyId: acme });
  });

  it('answers every failure reason identically (no account enumeration)', async () => {
    const ok = await freshUser();
    const inactive = await freshUser({ active: false });
    const deleted = await freshUser();
    await t.db
      .updateTable('users')
      .set({ deleted_at: new Date() })
      .where('id', '=', deleted.id)
      .execute();
    // حساب أُنشئ دون كلمة مرور (مثلاً دعوة لم تُفعَّل بعد): يجب ألا يمكن الدخول به أبداً.
    // An account created without a password (e.g. an invitation not yet activated): it must never be able to log in.
    const noPassword = `nopw${++n}`;
    await t.db
      .insertInto('users')
      .values({
        id: newId(),
        company_id: acme,
        username: noPassword,
        display_name: 'no password',
        created_by: null,
        updated_by: null,
        deleted_at: null,
        password_hash: null,
        password_changed_at: null,
        locked_until: null,
        last_login_at: null,
      })
      .execute();

    const attempts = [
      { companyCode: 'acme', username: ok.username, password: 'wrong-password-1' },
      { companyCode: 'acme', username: 'nobody-here', password: PASSWORD },
      { companyCode: 'no-such-company', username: ok.username, password: PASSWORD },
      { companyCode: 'acme', username: inactive.username, password: PASSWORD },
      { companyCode: 'acme', username: deleted.username, password: PASSWORD },
      { companyCode: 'acme', username: noPassword, password: PASSWORD },
    ];
    const bodies = [];
    for (const a of attempts) {
      const res = await login(a);
      expect(res.status).toBe(401);
      expect(res.body.error).toMatchObject({
        code: 'INVALID_CREDENTIALS',
        status: 401,
        details: null,
      });
      bodies.push({ ...res.body.error, requestId: 'x' });
    }
    for (const b of bodies) expect(b).toEqual(bodies[0]);
  });

  it('rejects malformed bodies with 400 and never echoes the submitted password', async () => {
    const secret = 'my-super-private-pw-777';
    const cases = [
      {},
      { companyCode: 'acme', username: 'a' },
      { companyCode: 'acme', username: 123, password: secret },
      { companyCode: 'x', username: 'a', password: secret },
      { companyCode: 'acme', username: 'a', password: secret, companyId: acme },
      { companyCode: 'acme', username: 'a', password: secret, role: 'admin' },
    ];
    for (const body of cases) {
      const res = await login(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(res.body)).not.toContain(secret);
    }
    const arr = await request(app).post('/api/v1/auth/login').send([1, 2]);
    expect(arr.status).toBe(400);
  });

  it('treats injection-looking input as plain data (401/400, never 500)', async () => {
    const payloads = ["' OR '1'='1", "admin'--", '"; DROP TABLE users; --', '%', '_'];
    for (const p of payloads) {
      const res = await login({ companyCode: 'acme', username: p, password: p });
      expect([400, 401]).toContain(res.status);
    }
    const stillThere = await t.db
      .selectFrom('users')
      .select(sql<string>`count(*)::text`.as('n'))
      .executeTakeFirst();
    expect(Number(stillThere?.n)).toBeGreaterThan(0);
  });
});

describe('account lockout', () => {
  const wrong = (username: string): request.Test =>
    login({ companyCode: 'acme', username, password: 'definitely-wrong-1' });

  it('locks after 5 failures, even for the correct password, and reports the wait', async () => {
    const u = await freshUser();
    for (let i = 1; i <= 4; i++) expect((await wrong(u.username)).status).toBe(401);
    const fifth = await wrong(u.username);
    expect(fifth.status).toBe(429);
    expect(fifth.body.error).toMatchObject({ code: 'ACCOUNT_LOCKED' });
    expect(fifth.body.error.details.retryAfterSeconds).toBeGreaterThan(14 * 60);

    const correct = await login({ companyCode: 'acme', username: u.username, password: PASSWORD });
    expect(correct.status).toBe(429);
  });

  it('does not extend the lock while locked', async () => {
    const u = await freshUser();
    for (let i = 0; i < 5; i++) await wrong(u.username);
    const before = await t.db
      .selectFrom('users')
      .select('locked_until')
      .where('id', '=', u.id)
      .executeTakeFirstOrThrow();
    await wrong(u.username);
    await wrong(u.username);
    const after = await t.db
      .selectFrom('users')
      .select(['locked_until', 'failed_login_count'])
      .where('id', '=', u.id)
      .executeTakeFirstOrThrow();
    expect(after.locked_until?.getTime()).toBe(before.locked_until?.getTime());
    expect(after.failed_login_count).toBe(5);
  });

  it('unlocks when the lock expires and resets the counter on success', async () => {
    const u = await freshUser();
    for (let i = 0; i < 5; i++) await wrong(u.username);
    await t.db
      .updateTable('users')
      .set({ locked_until: new Date(Date.now() - 1000) })
      .where('id', '=', u.id)
      .execute();

    const res = await login({ companyCode: 'acme', username: u.username, password: PASSWORD });
    expect(res.status).toBe(200);
    const row = await t.db
      .selectFrom('users')
      .select(['failed_login_count', 'locked_until'])
      .where('id', '=', u.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ failed_login_count: 0, locked_until: null });
  });

  it('restarts counting after an expired lock instead of re-locking at once', async () => {
    const u = await freshUser();
    for (let i = 0; i < 5; i++) await wrong(u.username);
    await t.db
      .updateTable('users')
      .set({ locked_until: new Date(Date.now() - 1000) })
      .where('id', '=', u.id)
      .execute();

    const res = await wrong(u.username);
    expect(res.status).toBe(401);
    const row = await t.db
      .selectFrom('users')
      .select('failed_login_count')
      .where('id', '=', u.id)
      .executeTakeFirstOrThrow();
    expect(row.failed_login_count).toBe(1);
  });

  it('resets the counter after a success below the limit', async () => {
    const u = await freshUser();
    for (let i = 0; i < 3; i++) await wrong(u.username);
    expect(
      (await login({ companyCode: 'acme', username: u.username, password: PASSWORD })).status,
    ).toBe(200);
    for (let i = 0; i < 3; i++) expect((await wrong(u.username)).status).toBe(401);
  });

  it('keeps counters per account: locking one user does not affect another', async () => {
    const a = await freshUser();
    const b = await freshUser();
    for (let i = 0; i < 5; i++) await wrong(a.username);
    expect(
      (await login({ companyCode: 'acme', username: b.username, password: PASSWORD })).status,
    ).toBe(200);
  });
});

describe('default deny under /api/v1', () => {
  const expired = async (): Promise<string> => {
    const svc = createTokenService(testConfig().jwtSecret, 900);
    const { token } = await svc.sign(
      { userId: acme, companyId: acme, sessionId: acme },
      new Date(Date.now() - 3600_000),
    );
    return token;
  };

  it('answers 401 without a token on every route except the public allowlist', async () => {
    const routes: Array<[string, string]> = [
      ['get', '/api/v1/auth/me'],
      ['post', '/api/v1/auth/change-password'],
      ['get', '/api/v1/secret'],
      ['get', '/api/v1/unknown'],
      ['post', '/api/v1/unknown'],
      ['delete', '/api/v1/auth/login'],
      ['get', '/api/v1/auth'],
      ['put', '/api/v1/anything/at/all'],
    ];
    for (const [method, path] of routes) {
      const res = await (request(app) as unknown as Record<string, (p: string) => request.Test>)[
        method
      ]!(path);
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('rejects malformed, forged and expired credentials', async () => {
    const u = await freshUser();
    const good = await loginAs(u.username);
    const wrongSecret = await createTokenService(
      'another-secret-0123456789-abcdefghijklmnopq',
      900,
    ).sign({ userId: u.id, companyId: acme, sessionId: newId() });
    const wrongAud = await new SignJWT({ cid: acme, sid: newId() })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(u.id)
      .setIssuer('inventory-audit')
      .setAudience('other')
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode(testConfig().jwtSecret));

    const headers = [
      'Bearer',
      'Bearer ',
      'Bearer garbage',
      `Basic ${good}`,
      good,
      `Bearer ${good} extra`,
      `Bearer ${wrongSecret.token}`,
      `Bearer ${wrongAud}`,
      `Bearer ${await expired()}`,
    ];
    for (const h of headers) {
      const res = await request(app).get('/api/v1/secret').set('Authorization', h);
      expect(res.status, h.slice(0, 30)).toBe(401);
    }
    expect(
      (
        await request(app)
          .get('/api/v1/secret')
          .set(...bearer(good))
      ).status,
    ).toBe(200);
  });

  it('is case-insensitive about the Bearer scheme', async () => {
    const u = await freshUser();
    const token = await loginAs(u.username);
    const res = await request(app).get('/api/v1/secret').set('Authorization', `bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it('returns the standard 404 shape to an authenticated caller on an unknown route', async () => {
    const u = await freshUser();
    const res = await request(app)
      .get('/api/v1/nothing-here')
      .set(...bearer(await loginAs(u.username)));
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  it('invalidates a token immediately when the user is disabled', async () => {
    const u = await freshUser();
    const token = await loginAs(u.username);
    expect(
      (
        await request(app)
          .get('/api/v1/secret')
          .set(...bearer(token))
      ).status,
    ).toBe(200);
    await t.db.updateTable('users').set({ active: false }).where('id', '=', u.id).execute();
    expect(
      (
        await request(app)
          .get('/api/v1/secret')
          .set(...bearer(token))
      ).status,
    ).toBe(401);
  });

  it('invalidates a token when the user is soft-deleted', async () => {
    const u = await freshUser();
    const token = await loginAs(u.username);
    await t.db
      .updateTable('users')
      .set({ deleted_at: new Date() })
      .where('id', '=', u.id)
      .execute();
    expect(
      (
        await request(app)
          .get('/api/v1/secret')
          .set(...bearer(token))
      ).status,
    ).toBe(401);
  });

  it('invalidates tokens when the whole company is soft-deleted', async () => {
    const cid = await seedCompany(t.db, 'Short Lived', 'short-lived');
    await seedLoginUser(t.db, cid, 'boss', PASSWORD);
    const token = await loginAs('boss', 'short-lived');
    expect(
      (
        await request(app)
          .get('/api/v1/secret')
          .set(...bearer(token))
      ).status,
    ).toBe(200);
    await t.db
      .updateTable('companies')
      .set({ deleted_at: new Date() })
      .where('id', '=', cid)
      .execute();
    expect(
      (
        await request(app)
          .get('/api/v1/secret')
          .set(...bearer(token))
      ).status,
    ).toBe(401);
  });
});

describe('temporary password enforcement (server side)', () => {
  it('lets a temporary-password user read identity and change the password, nothing else', async () => {
    const u = await freshUser({ mustChangePassword: true });
    const login1 = await login({ companyCode: 'acme', username: u.username, password: PASSWORD });
    expect(login1.status).toBe(200);
    expect(login1.body.data.user.mustChangePassword).toBe(true);
    const token = login1.body.data.accessToken as string;

    expect(
      (
        await request(app)
          .get('/api/v1/auth/me')
          .set(...bearer(token))
      ).status,
    ).toBe(200);
    for (const path of ['/api/v1/secret', '/api/v1/unknown']) {
      const res = await request(app)
        .get(path)
        .set(...bearer(token));
      expect(res.status, path).toBe(403);
      expect(res.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    }

    const changed = await request(app)
      .post('/api/v1/auth/change-password')
      .set(...bearer(token))
      .send({ currentPassword: PASSWORD, newPassword: 'brand-new-password-42' });
    expect(changed.status).toBe(200);

    // الحالة تُقرأ من القاعدة، فالتوكن نفسه يعمل فوراً بعد التغيير.
    // State is read from the database, so the same token works right after the change.
    expect(
      (
        await request(app)
          .get('/api/v1/secret')
          .set(...bearer(token))
      ).status,
    ).toBe(200);
    expect(
      (await login({ companyCode: 'acme', username: u.username, password: PASSWORD })).status,
    ).toBe(401);
    const again = await login({
      companyCode: 'acme',
      username: u.username,
      password: 'brand-new-password-42',
    });
    expect(again.status).toBe(200);
    expect(again.body.data.user.mustChangePassword).toBe(false);
  });
});

describe('POST /auth/change-password', () => {
  const change = (token: string, body: Record<string, unknown>): request.Test =>
    request(app)
      .post('/api/v1/auth/change-password')
      .set(...bearer(token))
      .send(body);

  it('stores a new scrypt hash and stamps the change time', async () => {
    const u = await freshUser();
    const token = await loginAs(u.username);
    const before = await t.db
      .selectFrom('users')
      .select('password_hash')
      .where('id', '=', u.id)
      .executeTakeFirstOrThrow();
    expect(
      (await change(token, { currentPassword: PASSWORD, newPassword: 'another-strong-pass-1' }))
        .status,
    ).toBe(200);
    const after = await t.db
      .selectFrom('users')
      .select(['password_hash', 'password_changed_at', 'updated_by'])
      .where('id', '=', u.id)
      .executeTakeFirstOrThrow();
    expect(after.password_hash).not.toBe(before.password_hash);
    expect(after.password_hash?.startsWith('scrypt$')).toBe(true);
    expect(after.password_hash).not.toContain('another-strong-pass-1');
    expect(after.password_changed_at).toBeInstanceOf(Date);
    expect(after.updated_by).toBe(u.id);
  });

  it('rejects a wrong current password', async () => {
    const u = await freshUser();
    const res = await change(await loginAs(u.username), {
      currentPassword: 'not-my-password-1',
      newPassword: 'another-strong-pass-1',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CURRENT_PASSWORD');
  });

  it('locks the account after repeated wrong current passwords (stolen-token guessing)', async () => {
    const u = await freshUser();
    const token = await loginAs(u.username);
    let last = 0;
    for (let i = 0; i < 5; i++) {
      last = (
        await change(token, {
          currentPassword: `guess-number-${i}-xx`,
          newPassword: 'another-strong-pass-1',
        })
      ).status;
    }
    expect(last).toBe(429);
    const correct = await change(token, {
      currentPassword: PASSWORD,
      newPassword: 'another-strong-pass-1',
    });
    expect(correct.status).toBe(429);
    expect(
      (await login({ companyCode: 'acme', username: u.username, password: PASSWORD })).status,
    ).toBe(429);
  });

  it('enforces the password policy and strict body shape', async () => {
    const u = await freshUser();
    const token = await loginAs(u.username);
    const bad: Array<Record<string, unknown>> = [
      { currentPassword: PASSWORD, newPassword: 'short' },
      { currentPassword: PASSWORD, newPassword: PASSWORD },
      { currentPassword: PASSWORD, newPassword: 'x'.repeat(129) },
      { currentPassword: PASSWORD },
      {
        currentPassword: PASSWORD,
        newPassword: 'another-strong-pass-1',
        mustChangePassword: false,
      },
    ];
    for (const body of bad) {
      const res = await change(token, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    // لم يتغير شيء.
    // Nothing changed.
    expect(
      (await login({ companyCode: 'acme', username: u.username, password: PASSWORD })).status,
    ).toBe(200);
  });
});

describe('rate limiting', () => {
  it('limits login attempts per ip + company + username', async () => {
    const limited = createApp({
      db: t.db,
      config: testConfig({
        rateLimit: { generalPerMinute: 100_000, loginPerWindow: 3, loginWindowMinutes: 15 },
      }),
    });
    const body = { companyCode: 'acme', username: 'ratelimited', password: 'whatever-123' };
    for (let i = 0; i < 3; i++) expect((await login(body, limited)).status).toBe(401);
    const blocked = await login(body, limited);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');

    // مستخدم آخر من العنوان نفسه لا يتأثر بحدّ المفتاح.
    // Another user from the same address is unaffected by the per-key limit.
    expect((await login({ ...body, username: 'someone-else' }, limited)).status).toBe(401);
  });

  it('applies a general per-address limit to the whole API', async () => {
    const limited = createApp({
      db: t.db,
      config: testConfig({
        rateLimit: { generalPerMinute: 3, loginPerWindow: 100, loginWindowMinutes: 15 },
      }),
    });
    for (let i = 0; i < 3; i++)
      expect((await request(limited).get('/api/v1/health')).status).toBe(200);
    const res = await request(limited).get('/api/v1/health');
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });
});

describe('error handling', () => {
  it('hides unexpected error details from the client but logs them with the request id', async () => {
    const u = await freshUser();
    const token = await loginAs(u.username);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = await request(app)
        .get('/api/v1/boom')
        .set(...bearer(token));
      expect(res.status).toBe(500);
      expect(res.body.error).toMatchObject({
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      });
      expect(JSON.stringify(res.body)).not.toContain('hunter2');
      const logged = String(spy.mock.calls[0]?.[0]);
      expect(logged).toContain(res.body.error.requestId);
    } finally {
      spy.mockRestore();
    }
  });
});
