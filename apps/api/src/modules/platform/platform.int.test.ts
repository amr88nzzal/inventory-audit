import request from 'supertest';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { createFieldCrypto } from '../../crypto/encryption';
import { withPlatform, withTenant } from '../../db';
import { createTestDb, seedCompany, seedLoginUser } from '../../testing/test-db';
import type { TestDb } from '../../testing/test-db';
import { testConfig } from '../../testing/test-config';
import { bootstrapPlatformAdmin, createPlatformAdmin, resetPlatformAdmin } from './index';
import { generateTotpSecret, totpAt } from './totp';

const PASSWORD = 'temporary-password-123';
const NEW_PASSWORD = 'my-own-long-password-456';

let t: TestDb;
let app: ReturnType<typeof createApp>;
let n = 0;
const config = testConfig();
const crypto = createFieldCrypto(config.encryption);

beforeAll(async () => {
  t = await createTestDb();
  app = createApp({ db: t.db, config });
});

afterAll(async () => {
  await t.cleanup();
});

const post = (url: string, body: unknown): request.Test =>
  request(app)
    .post(`/api/v1/platform${url}`)
    .send(body as object);

const newAdmin = async (): Promise<{ id: string; username: string }> => {
  const username = `root${++n}`;
  const { id } = await createPlatformAdmin({ db: t.db, config }, { username, password: PASSWORD });
  return { id, username };
};

// مدير مربوط مسبقاً بسر معروف للاختبار (يتجاوز خطوة الربط).
// An admin already enrolled with a secret known to the test (skips the enrollment step).
const enrolledAdmin = async (): Promise<{ id: string; username: string; secret: string }> => {
  const admin = await newAdmin();
  const secret = generateTotpSecret();
  await withPlatform(t.db, (trx) =>
    trx
      .updateTable('platform_admins')
      .set({
        totp_secret_enc: crypto.encrypt(secret, `platform_admins:${admin.id}:totp`),
        totp_enrolled_at: new Date(),
        must_change_password: false,
      })
      .where('id', '=', admin.id)
      .execute(),
  );
  return { ...admin, secret };
};

const nowCode = (secret: string, stepOffset = 0): string =>
  totpAt(secret, Date.now() + stepOffset * 30_000);

const fullLogin = async (a: { username: string; secret: string }): Promise<string> => {
  const step1 = await post('/auth/login', { username: a.username, password: PASSWORD });
  expect(step1.status).toBe(200);
  const res = await post('/auth/verify', {
    mfaToken: step1.body.data.mfaToken,
    code: nowCode(a.secret),
  });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
};

const me = (token: string): request.Test =>
  request(app).get('/api/v1/platform/me').set('Authorization', `Bearer ${token}`);

describe('first sign-in: enrollment', () => {
  it('shows the secret once, enrolls with a code, forces a new password, then issues a token', async () => {
    const a = await newAdmin();
    const login = await post('/auth/login', { username: a.username, password: PASSWORD });
    expect(login.status).toBe(200);
    const { step, enrollToken, totp, mustChangePassword } = login.body.data;
    expect(step).toBe('enroll');
    expect(mustChangePassword).toBe(true);
    expect(totp.otpauthUri).toContain(`secret=${totp.secret}`);

    // السر مخزّن مشفراً لا نصاً. The secret is stored encrypted, never as text.
    const row = await withPlatform(t.db, (trx) =>
      trx
        .selectFrom('platform_admins')
        .select('totp_secret_enc')
        .where('id', '=', a.id)
        .executeTakeFirstOrThrow(),
    );
    expect(row.totp_secret_enc).not.toContain(totp.secret);
    expect(row.totp_secret_enc?.startsWith('v1:t1:')).toBe(true);

    const code = totpAt(totp.secret, Date.now());
    const noPassword = await post('/auth/enroll', { enrollToken, code });
    expect(noPassword.status).toBe(400);

    const done = await post('/auth/enroll', { enrollToken, code, newPassword: NEW_PASSWORD });
    expect(done.status).toBe(200);
    expect((await me(done.body.data.accessToken)).status).toBe(200);

    // الكلمة المؤقتة لم تعد تعمل، والجديدة تطلب الرمز.
    // The temporary password no longer works, and the new one asks for the code.
    expect((await post('/auth/login', { username: a.username, password: PASSWORD })).status).toBe(
      401,
    );
    const again = await post('/auth/login', { username: a.username, password: NEW_PASSWORD });
    expect(again.body.data.step).toBe('totp');
  });

  it('a wrong enrollment code is refused, and a new sign-in replaces the unconfirmed secret', async () => {
    const a = await newAdmin();
    const first = await post('/auth/login', { username: a.username, password: PASSWORD });
    const wrong = await post('/auth/enroll', {
      enrollToken: first.body.data.enrollToken,
      code: '000000',
      newPassword: NEW_PASSWORD,
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_CODE');

    const second = await post('/auth/login', { username: a.username, password: PASSWORD });
    expect(second.body.data.totp.secret).not.toBe(first.body.data.totp.secret);
    // رمز السر القديم لا يكمل الربط. A code from the old secret cannot complete enrollment.
    const stale = await post('/auth/enroll', {
      enrollToken: second.body.data.enrollToken,
      code: totpAt(first.body.data.totp.secret, Date.now()),
      newPassword: NEW_PASSWORD,
    });
    expect(stale.status).toBe(401);
  });
});

describe('sign-in with TOTP', () => {
  it('password then code gives access; the same code cannot be replayed', async () => {
    const a = await enrolledAdmin();
    const step1 = await post('/auth/login', { username: a.username, password: PASSWORD });
    expect(step1.body.data.step).toBe('totp');
    const code = nowCode(a.secret);
    const ok = await post('/auth/verify', { mfaToken: step1.body.data.mfaToken, code });
    expect(ok.status).toBe(200);
    expect((await me(ok.body.data.accessToken)).status).toBe(200);

    const step1b = await post('/auth/login', { username: a.username, password: PASSWORD });
    const replay = await post('/auth/verify', { mfaToken: step1b.body.data.mfaToken, code });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('INVALID_CODE');
  });

  it('two concurrent requests with the same code: exactly one succeeds', async () => {
    const a = await enrolledAdmin();
    const tokens = await Promise.all(
      [1, 2, 3].map(
        async () =>
          (await post('/auth/login', { username: a.username, password: PASSWORD })).body.data
            .mfaToken as string,
      ),
    );
    const code = nowCode(a.secret);
    const results = await Promise.all(
      tokens.map((mfaToken) => post('/auth/verify', { mfaToken, code })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it('unknown user, wrong password and inactive admin give the same answer', async () => {
    const a = await enrolledAdmin();
    const inactive = await enrolledAdmin();
    await withPlatform(t.db, (trx) =>
      trx
        .updateTable('platform_admins')
        .set({ active: false })
        .where('id', '=', inactive.id)
        .execute(),
    );
    const bodies = [];
    for (const [username, password] of [
      ['nobody-here', PASSWORD],
      [a.username, 'wrong-password-123'],
      [inactive.username, PASSWORD],
    ] as const) {
      const res = await post('/auth/login', { username, password });
      expect(res.status).toBe(401);
      bodies.push({ ...res.body.error, requestId: undefined });
    }
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
  });

  it('locks after repeated failures, counting wrong codes too', async () => {
    const a = await enrolledAdmin();
    const step1 = await post('/auth/login', { username: a.username, password: PASSWORD });
    for (let i = 0; i < config.loginMaxFailures; i++) {
      const bad = await post('/auth/verify', {
        mfaToken: step1.body.data.mfaToken,
        code: '000000',
      });
      expect([401, 429]).toContain(bad.status);
    }
    const locked = await post('/auth/verify', {
      mfaToken: step1.body.data.mfaToken,
      code: nowCode(a.secret),
    });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
    // حتى كلمة المرور الصحيحة لا تدخل أثناء القفل. Even the right password gets nowhere while locked.
    expect((await post('/auth/login', { username: a.username, password: PASSWORD })).status).toBe(
      429,
    );
  });

  it('a successful password step does not reset the failure counter (no guessing across sign-ins)', async () => {
    const a = await enrolledAdmin();
    for (let i = 0; i < config.loginMaxFailures - 1; i++) {
      const s = await post('/auth/login', { username: a.username, password: PASSWORD });
      await post('/auth/verify', { mfaToken: s.body.data.mfaToken, code: '000000' });
    }
    const s = await post('/auth/login', { username: a.username, password: PASSWORD });
    const last = await post('/auth/verify', { mfaToken: s.body.data.mfaToken, code: '000000' });
    expect(last.status).toBe(429);
  });
});

describe('token separation', () => {
  it('step tokens and company tokens are not platform access tokens, and vice versa', async () => {
    const a = await enrolledAdmin();
    const step1 = await post('/auth/login', { username: a.username, password: PASSWORD });
    // توكن مرحلة كوصول. A step token used as access.
    expect((await me(step1.body.data.mfaToken)).status).toBe(401);
    // توكن مرحلة في خطوة أخرى. A step token in the wrong step.
    const wrong = await post('/auth/enroll', {
      enrollToken: step1.body.data.mfaToken,
      code: nowCode(a.secret),
      newPassword: NEW_PASSWORD,
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_STEP_TOKEN');

    // توكن شركة على المنصة، وتوكن منصة على الشركات. A company token on the platform and a platform token on companies.
    const co = await seedCompany(t.db, 'Acme', `acme${++n}`);
    const code = (
      await sql<{ code: string }>`SELECT code FROM companies WHERE id = ${co}`.execute(t.db)
    ).rows[0]!.code;
    await seedLoginUser(t.db, co, 'u1', 'correct-horse-battery-9');
    const company = await request(app)
      .post('/api/v1/auth/login')
      .send({ companyCode: code, username: 'u1', password: 'correct-horse-battery-9' });
    const companyToken = company.body.data.accessToken as string;
    expect((await me(companyToken)).status).toBe(401);

    const platformToken = await fullLogin(a);
    expect(
      (await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${platformToken}`))
        .status,
    ).toBe(401);
    expect(
      (await request(app).get('/api/v1/roles').set('Authorization', `Bearer ${platformToken}`))
        .status,
    ).toBe(401);
  });

  it('default deny: everything after sign-in needs a platform token, even unknown routes', async () => {
    for (const path of ['/me', '/companies', '/anything/at/all']) {
      expect((await request(app).get(`/api/v1/platform${path}`)).status, path).toBe(401);
    }
    expect((await request(app).post('/api/v1/platform/companies').send({})).status).toBe(401);
  });

  it('disabling or resetting an admin cuts the token at once', async () => {
    const a = await enrolledAdmin();
    const token = await fullLogin(a);
    expect((await me(token)).status).toBe(200);
    await withPlatform(t.db, (trx) =>
      trx.updateTable('platform_admins').set({ active: false }).where('id', '=', a.id).execute(),
    );
    expect((await me(token)).status).toBe(401);

    const b = await enrolledAdmin();
    const tokenB = await fullLogin(b);
    expect(
      await resetPlatformAdmin({ db: t.db, config }, b.username, 'another-temporary-pass-1'),
    ).toBe(true);
    expect((await me(tokenB)).status).toBe(401);
    // بعد إعادة التهيئة: يُطلب الربط من جديد بالكلمة الجديدة. After a reset: enrollment is required again with the new password.
    const again = await post('/auth/login', {
      username: b.username,
      password: 'another-temporary-pass-1',
    });
    expect(again.body.data.step).toBe('enroll');
    expect(
      await resetPlatformAdmin({ db: t.db, config }, 'ghost-user', 'another-temporary-pass-1'),
    ).toBe(false);
  });
});

describe('token version', () => {
  it('bumping token_version voids access tokens and pending sign-in steps', async () => {
    const a = await enrolledAdmin();
    const access = await fullLogin(a);
    const step1 = await post('/auth/login', { username: a.username, password: PASSWORD });
    await withPlatform(t.db, (trx) =>
      trx
        .updateTable('platform_admins')
        .set((eb) => ({ token_version: eb('token_version', '+', 1) }))
        .where('id', '=', a.id)
        .execute(),
    );
    expect((await me(access)).status).toBe(401);
    const stale = await post('/auth/verify', {
      mfaToken: step1.body.data.mfaToken,
      code: nowCode(a.secret, 1),
    });
    expect(stale.status).toBe(401);
    expect(stale.body.error.code).toBe('INVALID_STEP_TOKEN');
  });
});

describe('isolation from company code', () => {
  it('the company role has no privilege on platform_admins', async () => {
    const co = await seedCompany(t.db, 'Iso', `iso${++n}`);
    await newAdmin();
    await expect(
      withTenant(t.db, { companyId: co }, ({ trx }) =>
        sql`SELECT 1 FROM platform_admins`.execute(trx),
      ),
    ).rejects.toThrow(/permission denied/);
    // والعكس: دور المنصة يقرأ الشركات (لإدارتها) لكن لا يملك صلاحية على جداول بياناتها كالمستخدمين.
    // And the reverse: the platform role reads companies (to manage them) but has no privilege on their data tables like users.
    await expect(
      withPlatform(t.db, (trx) => sql`SELECT 1 FROM companies`.execute(trx)),
    ).resolves.toBeDefined();
    await expect(
      withPlatform(t.db, (trx) => sql`SELECT 1 FROM users`.execute(trx)),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('creation', () => {
  it('rejects a duplicate username (case-insensitive), weak passwords and short names', async () => {
    const a = await newAdmin();
    await expect(
      createPlatformAdmin(
        { db: t.db, config },
        { username: a.username.toUpperCase(), password: PASSWORD },
      ),
    ).rejects.toMatchObject({ code: 'USERNAME_TAKEN' });
    await expect(
      createPlatformAdmin({ db: t.db, config }, { username: `x${++n}admin`, password: 'short' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      createPlatformAdmin({ db: t.db, config }, { username: 'ab', password: PASSWORD }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('bootstrap from the environment', () => {
  it('creates the first admin only when none exists, logs no secret, and never resets', async () => {
    const own = await createTestDb();
    try {
      const logs: Record<string, unknown>[] = [];
      const cfg = {
        ...config,
        platform: {
          ...config.platform,
          bootstrap: { username: 'boot-admin', password: 'bootstrap-password-1' },
        },
      };
      const deps = { db: own.db, config: cfg };
      expect(await bootstrapPlatformAdmin(deps, (e) => logs.push(e))).toBe('created');
      expect(await bootstrapPlatformAdmin(deps, (e) => logs.push(e))).toBe('skipped_exists');
      expect(JSON.stringify(logs)).not.toContain('bootstrap-password-1');

      const row = await withPlatform(own.db, (trx) =>
        trx.selectFrom('platform_admins').select(['username', 'must_change_password']).execute(),
      );
      expect(row).toEqual([{ username: 'boot-admin', must_change_password: true }]);

      // تغيير كلمة المرور في البيئة لا يعيد تهيئة المدير الموجود.
      // Changing the password in the environment does not reset the existing admin.
      const changed = {
        ...cfg,
        platform: {
          ...cfg.platform,
          bootstrap: { username: 'boot-admin', password: 'a-different-password-2' },
        },
      };
      expect(await bootstrapPlatformAdmin({ db: own.db, config: changed }, () => undefined)).toBe(
        'skipped_exists',
      );
      const loginOld = await request(createApp({ db: own.db, config: cfg }))
        .post('/api/v1/platform/auth/login')
        .send({ username: 'boot-admin', password: 'bootstrap-password-1' });
      expect(loginOld.status).toBe(200);

      expect(await bootstrapPlatformAdmin({ db: own.db, config }, () => undefined)).toBe(
        'skipped_not_configured',
      );
    } finally {
      await own.cleanup();
    }
  });
});

describe('address allowlist', () => {
  it('hides the whole platform area (404) from other addresses', async () => {
    const guarded = createApp({
      db: t.db,
      config: { ...config, platform: { ...config.platform, allowedIps: ['203.0.113.9'] } },
    });
    for (const [method, path] of [
      ['post', '/api/v1/platform/auth/login'],
      ['get', '/api/v1/platform/me'],
      ['get', '/api/v1/platform/whatever'],
    ] as const) {
      const res = await request(guarded)[method](path).send({});
      expect(res.status, path).toBe(404);
    }
    const allowed = await request(guarded)
      .post('/api/v1/platform/auth/login')
      .set('X-Forwarded-For', '203.0.113.9')
      .send({ username: 'nobody', password: 'x' });
    expect(allowed.status).toBe(401);
  });
});

describe('input validation', () => {
  it('rejects malformed bodies and extra fields with 400', async () => {
    for (const [url, body] of [
      ['/auth/login', {}],
      ['/auth/login', { username: 'a', password: 'b', extra: 1 }],
      ['/auth/verify', { mfaToken: 'short', code: '123456' }],
      ['/auth/verify', { mfaToken: 'x'.repeat(30), code: '12345' }],
      ['/auth/enroll', { enrollToken: 'x'.repeat(30), code: 'abcdef' }],
    ] as const) {
      expect((await post(url, body)).status, url).toBe(400);
    }
  });
});

describe('company creation', () => {
  const auth = (token: string, method: 'get' | 'post', body?: object): request.Test => {
    const base = request(app);
    const r = (method === 'get' ? base.get : base.post)
      .call(base, '/api/v1/platform/companies')
      .set('Authorization', `Bearer ${token}`);
    return body ? r.send(body) : r;
  };
  const input = (code: string) => ({
    name: 'Acme Trading',
    code,
    admin: { username: 'boss', displayName: 'The Boss' },
  });
  let token: string;
  beforeAll(async () => {
    token = await fullLogin(await enrolledAdmin());
  });

  it('creates company + admin atomically; the temporary password works once and forces a change', async () => {
    const res = await auth(token, 'post', input('acme-co'));
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const { company, admin, temporaryPassword } = res.body.data;
    expect(company).toMatchObject({ name: 'Acme Trading', code: 'acme-co', isDemo: false });
    expect(temporaryPassword.length).toBeGreaterThanOrEqual(20);

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ companyCode: 'acme-co', username: 'boss', password: temporaryPassword });
    expect(login.status).toBe(200);
    // كلمة مؤقتة: كل مسار عدا تغييرها مرفوض. Temporary: every route but changing it is refused.
    const perms = await request(app)
      .get('/api/v1/permissions/mine')
      .set('Authorization', `Bearer ${login.body.data.accessToken}`);
    expect(perms.status).toBe(403);
    expect(perms.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    // الأدمن يحمل دور المدير، وكلمته مجزَّأة لا نص. The admin holds the admin role; the password is stored hashed.
    const stored = await withTenant(t.db, { companyId: company.id }, async ({ trx }) => ({
      user: await trx
        .selectFrom('users')
        .select(['password_hash', 'must_change_password'])
        .where('id', '=', admin.id)
        .executeTakeFirstOrThrow(),
      roles: await trx
        .selectFrom('user_roles')
        .select('role_id')
        .where('user_id', '=', admin.id)
        .execute(),
    }));
    expect(stored.user.password_hash).not.toContain(temporaryPassword);
    expect(stored.user.must_change_password).toBe(true);
    expect(stored.roles).toHaveLength(1);
  });

  it('the temporary password is never returned again (list shows no secrets)', async () => {
    const list = await auth(token, 'get');
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toMatch(/password/i);
    expect(list.body.data.map((c: { code: string }) => c.code)).toContain('acme-co');
  });

  it('rejects duplicate and reserved codes, bad input and mass assignment; leaves nothing half-created', async () => {
    expect((await auth(token, 'post', input('acme-co'))).body.error.code).toBe(
      'COMPANY_CODE_TAKEN',
    );
    for (const code of ['demo', 'demo-old-x1', 'demo-2']) {
      expect((await auth(token, 'post', input(code))).body.error.code, code).toBe(
        'COMPANY_CODE_RESERVED',
      );
    }
    for (const bad of [
      { ...input('x'), code: 'A B' },
      { ...input('ok-code'), isDemo: true },
      { ...input('ok-code'), admin: { username: 'u', password: 'chosen-by-client-1' } },
      { name: 'x', code: 'ok-code' },
    ]) {
      expect((await auth(token, 'post', bad)).status).toBe(400);
    }
    // فشل الإنشاء لا يترك شركة يتيمة. A failed creation leaves no orphan company.
    const orphan = await withPlatform(t.db, (trx) =>
      trx.selectFrom('companies').select('id').where('code', '=', 'ok-code').execute(),
    );
    expect(orphan).toHaveLength(0);
  });

  it('requires a platform token: none, or a company token, is refused', async () => {
    expect(
      (await request(app).post('/api/v1/platform/companies').send(input('nope-co'))).status,
    ).toBe(401);
    const co = await seedCompany(t.db, 'Other', 'other-co');
    await seedLoginUser(t.db, co, 'u1', 'correct-horse-battery-9');
    const lt = await request(app)
      .post('/api/v1/auth/login')
      .send({ companyCode: 'other-co', username: 'u1', password: 'correct-horse-battery-9' });
    const res = await auth(lt.body.data.accessToken, 'post', input('nope-co'));
    expect(res.status).toBe(401);
  });

  it('the new company is isolated from existing ones', async () => {
    const a = await auth(token, 'post', { ...input('iso-a'), admin: { username: 'same' } });
    const b = await auth(token, 'post', { ...input('iso-b'), admin: { username: 'same' } });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    // رمز شركة وكلمة شركة أخرى لا تفتح. Another company's code with this company's password fails.
    const cross = await request(app).post('/api/v1/auth/login').send({
      companyCode: 'iso-b',
      username: 'same',
      password: a.body.data.temporaryPassword,
    });
    expect(cross.status).toBe(401);
  });

  it('the app role still cannot create companies, and the platform role cannot update real ones', async () => {
    await expect(
      withTenant(t.db, { companyId: await seedCompany(t.db, 'X', 'x-co') }, ({ trx }) =>
        sql`INSERT INTO companies (id, name, code) VALUES (gen_random_uuid(), 'r', 'rogue-2')`.execute(
          trx,
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    const upd = await withPlatform(t.db, (trx) =>
      trx
        .updateTable('companies')
        .set({ name: 'hacked' })
        .where('code', '=', 'acme-co')
        .executeTakeFirst(),
    );
    expect(Number(upd.numUpdatedRows)).toBe(0);
  });
});
