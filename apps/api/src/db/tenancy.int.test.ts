import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, withTenant } from '../db';
import { createTestDb, seedCompany, seedUser } from '../testing/test-db';
import type { TestDb } from '../testing/test-db';

// اتصال واحد فقط (max: 1) كي يستعمل كل طلب الاتصال نفسه، فيظهر أي تسرّب للسياق بين المعاملات.
// A single connection (max: 1) so every call reuses it, which exposes any context leak between transactions.
let t: TestDb;
let companyA: string;
let companyB: string;
let userA1: string;
let userB1: string;

beforeAll(async () => {
  t = await createTestDb({ max: 1 });
  companyA = await seedCompany(t.db, 'Company A');
  companyB = await seedCompany(t.db, 'Company B');
  userA1 = await seedUser(t.db, companyA, 'alice');
  await seedUser(t.db, companyA, 'adam');
  userB1 = await seedUser(t.db, companyB, 'bob');
});

afterAll(async () => {
  await t.cleanup();
});

// كلا خطأ سياسة RLS وخطأ نقص الصلاحية يحملان الرمز 42501.
// Both an RLS policy violation and a missing privilege carry code 42501.
const expectPgCode = async (promise: Promise<unknown>, code: string): Promise<void> => {
  await expect(promise).rejects.toMatchObject({ code });
};

describe('tenant isolation (two companies)', () => {
  it('each company sees only its own users', async () => {
    const a = await withTenant(t.db, { companyId: companyA }, ({ trx }) =>
      trx.selectFrom('users').select('username').orderBy('username').execute(),
    );
    const b = await withTenant(t.db, { companyId: companyB }, ({ trx }) =>
      trx.selectFrom('users').select('username').execute(),
    );
    expect(a.map((u) => u.username)).toEqual(['adam', 'alice']);
    expect(b.map((u) => u.username)).toEqual(['bob']);
  });

  it('each company sees only its own company row', async () => {
    const rows = await withTenant(t.db, { companyId: companyA }, ({ trx }) =>
      trx.selectFrom('companies').select(['id', 'name']).execute(),
    );
    expect(rows).toEqual([{ id: companyA, name: 'Company A' }]);
  });

  it("cannot read another company's user by id (looks like not found)", async () => {
    const row = await withTenant(t.db, { companyId: companyA }, ({ trx }) =>
      trx.selectFrom('users').selectAll().where('id', '=', userB1).executeTakeFirst(),
    );
    expect(row).toBeUndefined();
  });

  it("cannot update another company's user (0 rows affected)", async () => {
    const res = await withTenant(t.db, { companyId: companyA }, ({ trx }) =>
      trx.updateTable('users').set({ display_name: 'hacked' }).where('id', '=', userB1).execute(),
    );
    expect(res[0]?.numUpdatedRows).toBe(0n);
    const check = await t.db
      .selectFrom('users')
      .select('display_name')
      .where('id', '=', userB1)
      .executeTakeFirstOrThrow();
    expect(check.display_name).toBe('bob');
  });

  it('rejects inserting a row with a forged company_id (mass assignment)', async () => {
    await expectPgCode(
      withTenant(t.db, { companyId: companyA }, ({ trx }) =>
        trx
          .insertInto('users')
          .values({
            id: newId(),
            company_id: companyB,
            username: 'intruder',
            display_name: 'intruder',
            created_by: null,
            updated_by: null,
            deleted_at: null,
          })
          .execute(),
      ),
      '42501',
    );
  });

  it("rejects moving an own row into another company's tenant", async () => {
    await expectPgCode(
      withTenant(t.db, { companyId: companyA }, ({ trx }) =>
        trx.updateTable('users').set({ company_id: companyB }).where('id', '=', userA1).execute(),
      ),
      '42501',
    );
  });

  it('can insert into its own company', async () => {
    const id = newId();
    await withTenant(t.db, { companyId: companyA }, ({ trx }) =>
      trx
        .insertInto('users')
        .values({
          id,
          company_id: companyA,
          username: 'carol',
          display_name: 'Carol',
          created_by: null,
          updated_by: null,
          deleted_at: null,
        })
        .execute(),
    );
    const found = await withTenant(t.db, { companyId: companyA }, ({ trx }) =>
      trx.selectFrom('users').select('id').where('id', '=', id).executeTakeFirst(),
    );
    expect(found?.id).toBe(id);
  });
});

describe('fail closed and least privilege', () => {
  it('sees nothing when the app role has no tenant context', async () => {
    const rows = await t.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE inventory_app`.execute(trx);
      return trx.selectFrom('users').selectAll().execute();
    });
    expect(rows).toEqual([]);
  });

  it('does not leak the context to the next transaction on the same connection', async () => {
    await withTenant(t.db, { companyId: companyA }, ({ trx }) =>
      trx.selectFrom('users').selectAll().execute(),
    );
    // max: 1 يضمن أن هذا الاستعلام يعيد استعمال الاتصال نفسه.
    // max: 1 guarantees this query reuses the same connection.
    const rows = await t.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE inventory_app`.execute(trx);
      return trx.selectFrom('users').selectAll().execute();
    });
    expect(rows).toEqual([]);
    const setting = await sql<{
      v: string | null;
    }>`SELECT current_setting('app.company_id', true) AS v`.execute(t.db);
    expect([null, '']).toContain(setting.rows[0]?.v);
  });

  it('runs as the non-owner, non-superuser, non-bypass app role inside withTenant', async () => {
    const info = await withTenant(
      t.db,
      { companyId: companyA, userId: userA1 },
      async ({ trx }) => {
        const who = await sql<{ current_user: string; company: string; user: string }>`
        SELECT current_user, current_setting('app.company_id') AS company,
               current_setting('app.user_id') AS user`.execute(trx);
        return who.rows[0];
      },
    );
    expect(info).toEqual({ current_user: 'inventory_app', company: companyA, user: userA1 });

    const role = await sql<{ rolsuper: boolean; rolbypassrls: boolean }>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'inventory_app'`.execute(t.db);
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });

    const owners = await sql<{ relname: string; owner: string }>`
      SELECT c.relname, pg_get_userbyid(c.relowner) AS owner
      FROM pg_class c WHERE c.relname IN ('users', 'companies')`.execute(t.db);
    expect(owners.rows.every((r) => r.owner !== 'inventory_app')).toBe(true);
  });

  it('has RLS enabled and forced on every tenant table', async () => {
    const rows = await sql<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relname IN ('users', 'companies') AND relkind = 'r' ORDER BY relname`.execute(t.db);
    expect(rows.rows).toEqual([
      { relname: 'companies', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'users', relrowsecurity: true, relforcerowsecurity: true },
    ]);
  });

  it('cannot create companies from the app role', async () => {
    await expectPgCode(
      withTenant(t.db, { companyId: companyA }, ({ trx }) =>
        trx
          .insertInto('companies')
          .values({
            id: newId(),
            name: 'Rogue',
            created_by: null,
            updated_by: null,
            deleted_at: null,
          })
          .execute(),
      ),
      '42501',
    );
  });

  it('cannot hard-delete users (soft delete only)', async () => {
    await expectPgCode(
      withTenant(t.db, { companyId: companyA }, ({ trx }) =>
        trx.deleteFrom('users').where('id', '=', userA1).execute(),
      ),
      '42501',
    );
  });

  it('rolls everything back when the callback throws', async () => {
    const id = newId();
    await expect(
      withTenant(t.db, { companyId: companyA }, async ({ trx }) => {
        await trx
          .insertInto('users')
          .values({
            id,
            company_id: companyA,
            username: 'ghost',
            display_name: 'Ghost',
            created_by: null,
            updated_by: null,
            deleted_at: null,
          })
          .execute();
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const row = await t.db.selectFrom('users').select('id').where('id', '=', id).executeTakeFirst();
    expect(row).toBeUndefined();
  });

  it.each([
    ['not-a-uuid'],
    [''],
    ["x'; DROP TABLE users; --"],
    ['00000000-0000-0000-0000-00000000000'],
  ])('rejects an invalid companyId (%s) before touching the database', async (bad) => {
    await expect(withTenant(t.db, { companyId: bad }, async () => 1)).rejects.toThrow(TypeError);
  });

  it('rejects an invalid userId', async () => {
    await expect(
      withTenant(t.db, { companyId: companyA, userId: 'nope' }, async () => 1),
    ).rejects.toThrow(TypeError);
  });
});

describe('usernames', () => {
  it('are unique per company, case-insensitively', async () => {
    await expectPgCode(seedUser(t.db, companyA, 'ALICE'), '23505');
  });

  it('may repeat across companies', async () => {
    await expect(seedUser(t.db, companyB, 'alice')).resolves.toBeTypeOf('string');
  });

  it('can be reused after a soft delete', async () => {
    const id = await seedUser(t.db, companyA, 'dave');
    await t.db.updateTable('users').set({ deleted_at: new Date() }).where('id', '=', id).execute();
    await expect(seedUser(t.db, companyA, 'dave')).resolves.toBeTypeOf('string');
  });
});
