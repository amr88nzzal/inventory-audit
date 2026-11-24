import request from 'supertest';
import type { Router } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app';
import { createAuthModule } from './modules/auth';
import { createPlatformModule } from './modules/platform';
import { createItemsModule } from './modules/items';
import { createRbacModule } from './modules/rbac';
import { createWarehousesModule } from './modules/warehouses';
import { createTestDb, seedCompany, seedLoginUser } from './testing/test-db';
import type { TestDb } from './testing/test-db';
import { testConfig } from './testing/test-config';

// اختبار أمني شامل: يستخرج كل مسار فعلي من الموجّهات ويتأكد أنه محمي كما تعلن القوائم أدناه.
// مسار جديد غير مصنَّف هنا يُفشل الاختبار، فلا يُنسى مسار دون حماية.
// A sweeping security test: it extracts every real route from the routers and checks each is protected
// as the lists below declare. A new route not classified here fails the test, so none is forgotten.
//
// عند إضافة وحدة أعمال: أضف موجّهها إلى `companyRouters` أدناه (بالبادئة التي يُركَّب بها).
// When adding a business module: add its router to `companyRouters` below (with its mount prefix).

const PASSWORD = 'correct-horse-battery-9';
const UUID = '00000000-0000-7000-8000-000000000001';

// مسارات الشركات العامة (بلا توكن). Public company routes (no token).
const PUBLIC = new Set([
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/refresh',
  'POST /api/v1/auth/logout',
]);
// تتطلب تسجيل دخول فقط (بلا صلاحية محددة). Need sign-in only (no specific permission).
const AUTH_ONLY = new Set([
  'GET /api/v1/auth/me',
  'POST /api/v1/auth/change-password',
  'POST /api/v1/auth/logout-all',
  'GET /api/v1/permissions/mine',
]);
// مسارات دخول مدير المنصة (قبل وجود توكن). Platform sign-in routes (before a token exists).
const PLATFORM_PUBLIC = new Set([
  'POST /api/v1/platform/auth/login',
  'POST /api/v1/platform/auth/verify',
  'POST /api/v1/platform/auth/enroll',
]);

interface RouteInfo {
  method: string;
  path: string;
  key: string;
}

const routesOf = (router: Router, prefix: string): RouteInfo[] => {
  const out: RouteInfo[] = [];
  for (const layer of (
    router as unknown as { stack: { route?: { path: string; methods: Record<string, boolean> } }[] }
  ).stack) {
    if (!layer.route) continue;
    for (const m of Object.keys(layer.route.methods)) {
      const path = `/api/v1${prefix}${layer.route.path}`.replace(/:[A-Za-z]+/g, UUID);
      const key = `${m.toUpperCase()} /api/v1${prefix}${layer.route.path}`;
      out.push({ method: m, path, key });
    }
  }
  return out;
};

let t: TestDb;
let app: ReturnType<typeof createApp>;
let companyRoutes: RouteInfo[];
let platformRoutes: RouteInfo[];
let plainToken: string;
let tempToken: string;
let companyA: string;
let companyB: string;

const send = (r: RouteInfo, token?: string): request.Test => {
  const base = request(app);
  const call = (
    {
      get: base.get,
      post: base.post,
      put: base.put,
      patch: base.patch,
      delete: base.delete,
    } as Record<string, typeof base.get>
  )[r.method]!;
  const req = call.call(base, r.path);
  if (token) req.set('Authorization', `Bearer ${token}`);
  return req.send({});
};

const login = async (code: string, username: string): Promise<string> => {
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ companyCode: code, username, password: PASSWORD });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
};

// توكن جديد لكل طلب مدمِّر: logout-all يُبطل كل جلسات المستخدم فلا يجوز أن يفسد ما بعده.
// A fresh token per destructive request: logout-all revokes all of the user's sessions and must not spoil later checks.
const fresh = (): Promise<string> => login('sec-a', 'plain');

beforeAll(async () => {
  t = await createTestDb();
  const config = testConfig();
  app = createApp({ db: t.db, config });
  const auth = createAuthModule({ db: t.db, config });
  const rbac = createRbacModule({ db: t.db });
  const platform = createPlatformModule({ db: t.db, config });
  const companyRouters: [Router, string][] = [
    [auth.publicRouter, '/auth'],
    [auth.protectedRouter, '/auth'],
    [rbac.router, ''],
    [createItemsModule({ db: t.db, requirePermission: rbac.requirePermission }).router, ''],
    [createWarehousesModule({ db: t.db, requirePermission: rbac.requirePermission }).router, ''],
  ];
  companyRoutes = companyRouters.flatMap(([r, p]) => routesOf(r, p));
  platformRoutes = [platform.publicRouter, platform.protectedRouter].flatMap((r) =>
    routesOf(r, '/platform'),
  );

  companyA = await seedCompany(t.db, 'Sec A', 'sec-a');
  companyB = await seedCompany(t.db, 'Sec B', 'sec-b');
  await seedLoginUser(t.db, companyA, 'plain', PASSWORD);
  await seedLoginUser(t.db, companyA, 'temp', PASSWORD, { mustChangePassword: true });
  await seedLoginUser(t.db, companyB, 'other', PASSWORD);
  plainToken = await login('sec-a', 'plain');
  tempToken = await login('sec-a', 'temp');
});

afterAll(async () => {
  await t.cleanup();
});

describe('route inventory', () => {
  it('finds the real routes (guards against an empty walk passing vacuously)', () => {
    expect(companyRoutes.length).toBeGreaterThanOrEqual(30);
    expect(platformRoutes.length).toBeGreaterThanOrEqual(6);
  });

  it('every listed public / auth-only route actually exists (no stale entries)', () => {
    const keys = new Set([...companyRoutes, ...platformRoutes].map((r) => r.key));
    for (const k of [...PUBLIC, ...AUTH_ONLY, ...PLATFORM_PUBLIC])
      expect(keys.has(k), k).toBe(true);
  });
});

describe('company routes', () => {
  it('everything except the public list rejects a missing, malformed or foreign token with 401', async () => {
    for (const r of companyRoutes.filter((x) => !PUBLIC.has(x.key))) {
      for (const token of [undefined, 'garbage', 'a.b.c']) {
        const res = await send(r, token);
        expect(res.status, `${r.key} token=${token}`).toBe(401);
      }
    }
  });

  it('a signed-in user with no role gets 403 on every route needing a permission', async () => {
    for (const r of companyRoutes.filter((x) => !PUBLIC.has(x.key) && !AUTH_ONLY.has(x.key))) {
      const res = await send(r, plainToken);
      expect(res.status, r.key).toBe(403);
    }
  });

  it('auth-only routes need a token but no permission (never 401/403 for a plain user)', async () => {
    for (const r of companyRoutes.filter((x) => AUTH_ONLY.has(x.key))) {
      const res = await send(r, await fresh());
      expect([401, 403], r.key).not.toContain(res.status);
    }
  });

  it('a temporary password blocks every protected route except changing it (server-side)', async () => {
    for (const r of companyRoutes.filter((x) => !PUBLIC.has(x.key))) {
      const res = await send(r, tempToken);
      // المسموحان بكلمة مؤقتة: قراءة الهوية وتغيير الكلمة (انظر ALLOWED_WHILE_PASSWORD_TEMPORARY).
      // The two allowed with a temporary password: reading identity and changing it.
      if (['POST /api/v1/auth/change-password', 'GET /api/v1/auth/me'].includes(r.key)) {
        expect(res.status, r.key).not.toBe(403);
      } else {
        expect(res.status, r.key).toBe(403);
        expect(res.body.error.code, r.key).toBe('PASSWORD_CHANGE_REQUIRED');
      }
    }
  });

  it('unknown paths and methods reveal nothing without a token', async () => {
    for (const path of [
      '/api/v1/nope',
      '/api/v1/roles/x/y',
      '/api/v1/admin',
      '/api/v1/platformx',
    ]) {
      expect((await request(app).get(path)).status, path).toBe(401);
    }
  });
});

describe('platform routes', () => {
  it('everything but sign-in needs a platform token; company tokens do not work', async () => {
    for (const r of platformRoutes.filter((x) => !PLATFORM_PUBLIC.has(x.key))) {
      for (const token of [undefined, 'garbage', plainToken]) {
        expect((await send(r, token)).status, `${r.key} token=${token ? 'set' : 'none'}`).toBe(401);
      }
    }
    expect((await request(app).get('/api/v1/platform/not-a-route')).status).toBe(401);
  });

  it('sign-in routes need no token and reject bad input with 400, never 5xx', async () => {
    for (const r of platformRoutes.filter((x) => PLATFORM_PUBLIC.has(x.key))) {
      expect((await send(r)).status, r.key).toBe(400);
    }
  });
});

describe('robustness', () => {
  it('no route answers 5xx to empty or hostile input', async () => {
    const hostile = [
      '{"__proto__":{"x":1}}',
      '[]',
      'null',
      '"str"',
      '{"a":"\'; DROP TABLE users;--"}',
    ];
    for (const r of [...companyRoutes, ...platformRoutes]) {
      for (const body of hostile) {
        for (const token of [undefined, await fresh()]) {
          const agent = request(app);
          const req = agent[r.method as 'post'](r.path).set('Content-Type', 'application/json');
          if (token) req.set('Authorization', `Bearer ${token}`);
          const res = await req.send(body);
          expect(res.status, `${r.key} ${body}`).toBeLessThan(500);
        }
      }
    }
  });

  it('error bodies use the standard shape and never leak internals', async () => {
    const res = await request(app).get('/api/v1/roles');
    expect(Object.keys(res.body.error).sort()).toEqual([
      'code',
      'details',
      'message',
      'requestId',
      'status',
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/at \S+ \(|node_modules|SELECT |password_hash/i);
  });

  it('sets security headers and hides the framework', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
  });
});

describe('tenant isolation across all id-based routes', () => {
  it('a company A admin gets 404 (not 403/200) for company B ids on every id route', async () => {
    const { ensureAdminRole, ensureUserRole } = await import('./modules/rbac');
    const { withTenant } = await import('./db');
    const adminId = await seedLoginUser(t.db, companyA, 'admin-a', PASSWORD);
    await withTenant(t.db, { companyId: companyA }, async ({ trx }) => {
      const role = await ensureAdminRole(trx, companyA, null);
      await ensureUserRole(trx, companyA, adminId, role, null);
    });
    const bUser = await withTenant(t.db, { companyId: companyB }, ({ trx }) =>
      trx.selectFrom('users').select('id').executeTakeFirstOrThrow(),
    );
    const bRole = await withTenant(t.db, { companyId: companyB }, async ({ trx }) =>
      ensureAdminRole(trx, companyB, null),
    );
    const token = await login('sec-a', 'admin-a');
    const call = (m: 'patch' | 'delete' | 'put', path: string, body: object = {}) =>
      request(app)[m](path).set('Authorization', `Bearer ${token}`).send(body);

    expect(
      (await call('patch', `/api/v1/roles/${bRole}`, { version: 1, name: 'hijack' })).status,
    ).toBe(404);
    expect((await call('delete', `/api/v1/roles/${bRole}`)).status).toBe(404);
    expect(
      (await call('put', `/api/v1/users/${bUser.id}/roles`, { roleIds: [bRole] })).status,
    ).toBe(404);
    // ولا يظهر أي دور من الشركة الأخرى في القائمة. And no role of the other company appears in the list.
    const list = await request(app).get('/api/v1/roles').set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(bRole);
  });
});
