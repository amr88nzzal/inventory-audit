import { Router } from 'express';
import request from 'supertest';
import { sql } from 'kysely';
import { PERMISSIONS } from '@inventory/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { newId, withTenant } from '../../db';
import { createTestDb, seedCompany, seedLoginUser } from '../../testing/test-db';
import type { TestDb } from '../../testing/test-db';
import { testConfig } from '../../testing/test-config';
import { ensureAdminRole } from './index';

const PASSWORD = 'correct-horse-battery-9';

let t: TestDb;
let acme: string;
let globex: string;
let app: ReturnType<typeof createApp>;
let acmeAdminRole: string;
let globexAdminRole: string;
let n = 0;

interface Actor {
  id: string;
  token: string;
}

const login = async (username: string, code: string): Promise<string> => {
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ companyCode: code, username, password: PASSWORD });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
};

const grantRole = (userId: string, roleId: string, companyId: string): Promise<unknown> =>
  withTenant(t.db, { companyId }, ({ trx }) =>
    trx
      .insertInto('user_roles')
      .values({ user_id: userId, role_id: roleId, company_id: companyId, created_by: null })
      .execute(),
  );

const makeUser = async (company: string, code: string, roleId?: string): Promise<Actor> => {
  const username = `rbac${++n}`;
  const id = await seedLoginUser(t.db, company, username, PASSWORD);
  if (roleId) await grantRole(id, roleId, company);
  return { id, token: await login(username, code) };
};

const makeRole = async (company: string, name: string, permissions: string[]): Promise<string> => {
  const id = newId();
  await withTenant(t.db, { companyId: company }, async ({ trx }) => {
    await trx
      .insertInto('roles')
      .values({
        id,
        company_id: company,
        code: null,
        name,
        description: null,
        created_by: null,
        updated_by: null,
        deleted_at: null,
      })
      .execute();
    if (permissions.length > 0) {
      await trx
        .insertInto('role_permissions')
        .values(permissions.map((permission) => ({ role_id: id, company_id: company, permission })))
        .execute();
    }
  });
  return id;
};

const as = (a: Actor) => ({
  get: (url: string) => request(app).get(url).set('Authorization', `Bearer ${a.token}`),
  post: (url: string) => request(app).post(url).set('Authorization', `Bearer ${a.token}`),
  patch: (url: string) => request(app).patch(url).set('Authorization', `Bearer ${a.token}`),
  put: (url: string) => request(app).put(url).set('Authorization', `Bearer ${a.token}`),
  del: (url: string) => request(app).delete(url).set('Authorization', `Bearer ${a.token}`),
});

const probe = (modules: {
  rbac: { requirePermission: (...p: ['identity.role.read']) => never };
}): Router => {
  const r = Router();
  r.get('/probe/read', modules.rbac.requirePermission('identity.role.read') as never, (_q, s) => {
    s.json({ data: { ok: true }, meta: {} });
  });
  return r;
};

beforeAll(async () => {
  t = await createTestDb();
  acme = await seedCompany(t.db, 'Acme', 'acme');
  globex = await seedCompany(t.db, 'Globex', 'globex');
  acmeAdminRole = await withTenant(t.db, { companyId: acme }, ({ trx }) =>
    ensureAdminRole(trx, acme, null),
  );
  globexAdminRole = await withTenant(t.db, { companyId: globex }, ({ trx }) =>
    ensureAdminRole(trx, globex, null),
  );
  app = createApp({
    db: t.db,
    config: testConfig(),
    permissionCacheTtlMs: 60_000,
    protectedRouters: (m) => [probe(m as never)],
  });
});

afterAll(async () => {
  await t.cleanup();
});

describe('permissions', () => {
  it('admin holds the whole catalog, a user with no role holds nothing', async () => {
    const admin = await makeUser(acme, 'acme', acmeAdminRole);
    const nobody = await makeUser(acme, 'acme');
    const a = await as(admin).get('/api/v1/permissions/mine');
    expect(a.body.data.permissions).toEqual([...PERMISSIONS].sort());
    const b = await as(nobody).get('/api/v1/permissions/mine');
    expect(b.body.data.permissions).toEqual([]);
  });

  it('unions the permissions of several roles and ignores unknown/removed ones', async () => {
    const r1 = await makeRole(acme, `r${++n}`, ['identity.role.read']);
    const r2 = await makeRole(acme, `r${++n}`, ['identity.role.create', 'legacy.thing.gone']);
    const u = await makeUser(acme, 'acme');
    await grantRole(u.id, r1, acme);
    await grantRole(u.id, r2, acme);
    // الذاكرة المؤقتة فارغة لهذا المستخدم بعد الدخول؛ نُبطلها بتغيير دور كي نقرأ من جديد.
    const res = await as(await makeUser(acme, 'acme', acmeAdminRole))
      .put(`/api/v1/users/${u.id}/roles`)
      .send({ roleIds: [r1, r2] });
    expect(res.status).toBe(200);
    const mine = await as(u).get('/api/v1/permissions/mine');
    expect(mine.body.data.permissions).toEqual(['identity.role.create', 'identity.role.read']);
  });

  it('requirePermission: 401 without token, 403 without permission, 200 with it', async () => {
    expect((await request(app).get('/api/v1/probe/read')).status).toBe(401);
    const nobody = await makeUser(acme, 'acme');
    const denied = await as(nobody).get('/api/v1/probe/read');
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('FORBIDDEN');
    const reader = await makeUser(
      acme,
      'acme',
      await makeRole(acme, `r${++n}`, ['identity.role.read']),
    );
    expect((await as(reader).get('/api/v1/probe/read')).status).toBe(200);
  });

  it('a revoked role takes effect immediately on this instance (cache invalidated)', async () => {
    const roleId = await makeRole(acme, `r${++n}`, ['identity.role.read']);
    const admin = await makeUser(acme, 'acme', acmeAdminRole);
    const u = await makeUser(acme, 'acme', roleId);
    expect((await as(u).get('/api/v1/roles')).status).toBe(200);
    const res = await as(admin).put(`/api/v1/users/${u.id}/roles`).send({ roleIds: [] });
    expect(res.status).toBe(200);
    expect((await as(u).get('/api/v1/roles')).status).toBe(403);
  });
});

describe('roles API', () => {
  it('requires the matching permission for each action (403)', async () => {
    const reader = await makeUser(
      acme,
      'acme',
      await makeRole(acme, `r${++n}`, ['identity.role.read']),
    );
    expect((await as(reader).get('/api/v1/roles')).status).toBe(200);
    expect(
      (await as(reader).post('/api/v1/roles').send({ name: 'x', permissions: [] })).status,
    ).toBe(403);
    expect(
      (await as(reader).patch(`/api/v1/roles/${newId()}`).send({ version: 1, name: 'y' })).status,
    ).toBe(403);
    expect((await as(reader).del(`/api/v1/roles/${newId()}`)).status).toBe(403);
    expect(
      (await as(reader).put(`/api/v1/users/${reader.id}/roles`).send({ roleIds: [] })).status,
    ).toBe(403);
  });

  it('creates, lists, updates (optimistic lock) and soft-deletes a role', async () => {
    const admin = await makeUser(acme, 'acme', acmeAdminRole);
    const created = await as(admin)
      .post('/api/v1/roles')
      .send({ name: `Auditors ${++n}`, description: 'd', permissions: ['identity.role.read'] });
    expect(created.status).toBe(201);
    const role = created.body.data;
    expect(role).toMatchObject({
      isSystem: false,
      version: 1,
      permissions: ['identity.role.read'],
    });

    const list = await as(admin).get('/api/v1/roles');
    expect(list.body.data.some((r: { id: string }) => r.id === role.id)).toBe(true);

    const upd = await as(admin)
      .patch(`/api/v1/roles/${role.id}`)
      .send({ version: 1, permissions: ['identity.role.read', 'identity.role.create'] });
    expect(upd.status).toBe(200);
    expect(upd.body.data.version).toBe(2);
    expect(upd.body.data.permissions).toEqual(['identity.role.create', 'identity.role.read']);

    const stale = await as(admin)
      .patch(`/api/v1/roles/${role.id}`)
      .send({ version: 1, name: 'late' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');

    expect((await as(admin).del(`/api/v1/roles/${role.id}`)).status).toBe(200);
    expect((await as(admin).del(`/api/v1/roles/${role.id}`)).status).toBe(404);
    const after = await as(admin).get('/api/v1/roles');
    expect(after.body.data.some((r: { id: string }) => r.id === role.id)).toBe(false);
  });

  it('rejects duplicate names (case-insensitive) with 409 and bad input with 400', async () => {
    const admin = await makeUser(acme, 'acme', acmeAdminRole);
    const name = `Dup ${++n}`;
    expect((await as(admin).post('/api/v1/roles').send({ name, permissions: [] })).status).toBe(
      201,
    );
    const dup = await as(admin)
      .post('/api/v1/roles')
      .send({ name: name.toUpperCase(), permissions: [] });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('ROLE_NAME_TAKEN');
    for (const body of [
      { name: 'x', permissions: ['bogus.perm.x'] },
      { name: '', permissions: [] },
      { name: 'x', permissions: [], companyId: globex },
    ]) {
      expect((await as(admin).post('/api/v1/roles').send(body)).status).toBe(400);
    }
  });

  it('system roles are immutable and roles in use cannot be deleted', async () => {
    const admin = await makeUser(acme, 'acme', acmeAdminRole);
    const patch = await as(admin)
      .patch(`/api/v1/roles/${acmeAdminRole}`)
      .send({ version: 1, name: 'Hacked' });
    expect(patch.status).toBe(409);
    expect(patch.body.error.code).toBe('ROLE_IMMUTABLE');
    expect((await as(admin).del(`/api/v1/roles/${acmeAdminRole}`)).status).toBe(409);

    const used = await makeRole(acme, `r${++n}`, []);
    await makeUser(acme, 'acme', used);
    const del = await as(admin).del(`/api/v1/roles/${used}`);
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe('ROLE_IN_USE');
  });

  it('a malformed id is 404, not a validation error', async () => {
    const admin = await makeUser(acme, 'acme', acmeAdminRole);
    expect((await as(admin).del('/api/v1/roles/not-a-uuid')).status).toBe(404);
    expect((await as(admin).put('/api/v1/users/nope/roles').send({ roleIds: [] })).status).toBe(
      404,
    );
  });
});

describe('privilege escalation', () => {
  it('cannot create or edit a role with permissions you do not hold', async () => {
    const limited = await makeUser(
      acme,
      'acme',
      await makeRole(acme, `r${++n}`, [
        'identity.role.create',
        'identity.role.update',
        'identity.role.read',
      ]),
    );
    const res = await as(limited)
      .post('/api/v1/roles')
      .send({ name: `Esc ${++n}`, permissions: ['identity.role.delete'] });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PERMISSION_ESCALATION');

    const ok = await as(limited)
      .post('/api/v1/roles')
      .send({ name: `Ok ${++n}`, permissions: ['identity.role.read'] });
    expect(ok.status).toBe(201);
    const up = await as(limited)
      .patch(`/api/v1/roles/${ok.body.data.id}`)
      .send({ version: 1, permissions: ['identity.user.assign_role'] });
    expect(up.status).toBe(403);
  });

  it('a user who can assign roles cannot make themselves admin', async () => {
    const assigner = await makeUser(
      acme,
      'acme',
      await makeRole(acme, `r${++n}`, ['identity.user.assign_role']),
    );
    const res = await as(assigner)
      .put(`/api/v1/users/${assigner.id}/roles`)
      .send({ roleIds: [acmeAdminRole] });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PERMISSION_ESCALATION');
  });
});

describe('last admin protection', () => {
  it('refuses to remove the only admin, allows it when another admin exists', async () => {
    // شركة معزولة بمدير واحد. A fresh company with exactly one admin.
    const co = await seedCompany(t.db, 'Solo', `solo${++n}`);
    const code = (
      await sql<{ code: string }>`SELECT code FROM companies WHERE id = ${co}`.execute(t.db)
    ).rows[0]!.code;
    const adminRole = await withTenant(t.db, { companyId: co }, ({ trx }) =>
      ensureAdminRole(trx, co, null),
    );
    const first = await makeUser(co, code, adminRole);

    const blocked = await as(first).put(`/api/v1/users/${first.id}/roles`).send({ roleIds: [] });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('LAST_ADMIN');

    const second = await makeUser(co, code, adminRole);
    const ok = await as(second).put(`/api/v1/users/${first.id}/roles`).send({ roleIds: [] });
    expect(ok.status).toBe(200);
    // الآن الثاني هو الأخير. Now the second is the last one.
    const again = await as(second).put(`/api/v1/users/${second.id}/roles`).send({ roleIds: [] });
    expect(again.status).toBe(409);
  });

  it('two admins demoting each other at once: exactly one succeeds (repeated rounds)', async () => {
    // سباق احتمالي: نكرره عدة جولات كي يُكشف غياب القفل بثقة، لا بالحظ.
    // A probabilistic race: repeated over several rounds so a missing lock is caught reliably, not by luck.
    for (let round = 0; round < 10; round++) {
      const co = await seedCompany(t.db, 'Race', `race${++n}`);
      const code = (
        await sql<{ code: string }>`SELECT code FROM companies WHERE id = ${co}`.execute(t.db)
      ).rows[0]!.code;
      const adminRole = await withTenant(t.db, { companyId: co }, ({ trx }) =>
        ensureAdminRole(trx, co, null),
      );
      const a = await makeUser(co, code, adminRole);
      const b = await makeUser(co, code, adminRole);
      const [r1, r2] = await Promise.all([
        as(a).put(`/api/v1/users/${b.id}/roles`).send({ roleIds: [] }),
        as(b).put(`/api/v1/users/${a.id}/roles`).send({ roleIds: [] }),
      ]);
      // الخاسر إما 409 (حماية آخر مدير) أو 403 (فقد صلاحيته قبل وصول طلبه)؛ الثابت: نجاح واحد
      // وبقاء مدير واحد. The loser is 409 (last-admin guard) or 403 (it lost its permission before
      // its request arrived); the invariant is one success and one admin left.
      const statuses = [r1.status, r2.status];
      expect(
        statuses.filter((s) => s === 200),
        `round ${round}: ${statuses}`,
      ).toHaveLength(1);
      const admins = await withTenant(t.db, { companyId: co }, ({ trx }) =>
        trx.selectFrom('user_roles').select('user_id').where('role_id', '=', adminRole).execute(),
      );
      expect(admins, `round ${round}`).toHaveLength(1);
    }
  });
});

describe('tenant isolation', () => {
  it('roles and users of another company are invisible and untouchable', async () => {
    const acmeAdmin = await makeUser(acme, 'acme', acmeAdminRole);
    const globexAdmin = await makeUser(globex, 'globex', globexAdminRole);
    const globexRole = await makeRole(globex, `gx${++n}`, ['identity.role.read']);

    const list = await as(acmeAdmin).get('/api/v1/roles');
    const ids = list.body.data.map((r: { id: string }) => r.id);
    expect(ids).not.toContain(globexRole);
    expect(ids).not.toContain(globexAdminRole);

    expect(
      (await as(acmeAdmin).patch(`/api/v1/roles/${globexRole}`).send({ version: 1, name: 'x' }))
        .status,
    ).toBe(404);
    expect((await as(acmeAdmin).del(`/api/v1/roles/${globexRole}`)).status).toBe(404);
    // مستخدم شركة أخرى: 404 لا 403. A user of another company: 404, not 403.
    expect(
      (await as(acmeAdmin).put(`/api/v1/users/${globexAdmin.id}/roles`).send({ roleIds: [] }))
        .status,
    ).toBe(404);
    // دور شركة أخرى لا يُسند. A role of another company cannot be assigned.
    const target = await makeUser(acme, 'acme');
    expect(
      (
        await as(acmeAdmin)
          .put(`/api/v1/users/${target.id}/roles`)
          .send({ roleIds: [globexRole] })
      ).status,
    ).toBe(404);
    // وما زال دور globex سليماً. And globex's role is untouched.
    const still = await as(globexAdmin).get('/api/v1/roles');
    expect(still.body.data.some((r: { id: string }) => r.id === globexRole)).toBe(true);
  });

  it('an admin of one company has no permissions in another (a role id does not travel)', async () => {
    const acmeAdmin = await makeUser(acme, 'acme', acmeAdminRole);
    // يحاول قراءة أدوار globex بتوكن acme: النتيجة أدوار acme فقط.
    const res = await as(acmeAdmin).get('/api/v1/roles');
    expect(res.body.data.every((r: { id: string }) => r.id !== globexAdminRole)).toBe(true);
  });
});
