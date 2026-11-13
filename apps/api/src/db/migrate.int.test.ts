import { cp, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../db';
import { migrationsDir } from '../testing/test-db';

const adminUrl =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const dbName = `inventory_test_mig_${Date.now().toString(36)}`;
const admin = new Pool({ connectionString: adminUrl, max: 1 });
const url = ((): string => {
  const u = new URL(adminUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
})();

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
});

afterAll(async () => {
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('runMigrations', () => {
  it('applies every migration on a fresh database', async () => {
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    const result = await runMigrations(url, migrationsDir);
    expect(result.applied).toEqual(files);
    expect(result.skipped).toEqual([]);
  });

  it('is idempotent: a second run applies nothing', async () => {
    const result = await runMigrations(url, migrationsDir);
    expect(result.applied).toEqual([]);
    expect(result.skipped.length).toBeGreaterThan(0);
  });

  it('refuses to boot when an applied migration was modified', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'mig-'));
    await cp(migrationsDir, tmp, { recursive: true });
    const [first] = (await readdir(tmp)).filter((f) => f.endsWith('.sql')).sort();
    await writeFile(path.join(tmp, first as string), '-- tampered\nSELECT 1;\n');
    await expect(runMigrations(url, tmp)).rejects.toThrow(/modified after being applied/);
  });

  it('rolls back a failing migration and records nothing', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'mig-'));
    await cp(migrationsDir, tmp, { recursive: true });
    await writeFile(
      path.join(tmp, '29990101000000_broken.sql'),
      'CREATE TABLE half_done (id int);\nSELECT * FROM table_that_does_not_exist;\n',
    );
    await expect(runMigrations(url, tmp)).rejects.toThrow(/29990101000000_broken\.sql failed/);

    const check = new Pool({ connectionString: url, max: 1 });
    try {
      const table = await check.query("SELECT to_regclass('public.half_done') AS t");
      expect(table.rows[0].t).toBeNull();
      const recorded = await check.query(
        "SELECT 1 FROM schema_migrations WHERE name = '29990101000000_broken.sql'",
      );
      expect(recorded.rowCount).toBe(0);
    } finally {
      await check.end();
    }
  });

  it('ignores files that do not match the naming convention', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'mig-'));
    await cp(migrationsDir, tmp, { recursive: true });
    await writeFile(path.join(tmp, 'notes.sql'), 'THIS IS NOT SQL');
    await expect(runMigrations(url, tmp)).resolves.toMatchObject({ applied: [] });
  });
});
