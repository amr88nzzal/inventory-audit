import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';

// ملفات SQL باسم <timestamp>_description.sql تُطبَّق بالترتيب، كل ملف في معاملة.
// SQL files named <timestamp>_description.sql are applied in order, one transaction each.
const FILE_RE = /^\d{14}_[a-z0-9_]+\.sql$/;

// رقم قفل استشاري ثابت كي لا تُشغَّل التهجيرات من نسختين للتطبيق معاً.
// Fixed advisory-lock key so two app instances never migrate concurrently.
const LOCK_KEY = 727_001;

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export const runMigrations = async (
  connectionString: string,
  dir: string = path.resolve(process.cwd(), 'migrations'),
): Promise<MigrationResult> => {
  const files = (await readdir(dir)).filter((f) => FILE_RE.test(f)).sort();
  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  const result: MigrationResult = { applied: [], skipped: [] };

  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);

    const done = new Map<string, string>();
    const rows = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    for (const r of rows.rows) done.set(r.name, r.checksum);

    for (const file of files) {
      const sql = await readFile(path.join(dir, file), 'utf8');
      const checksum = sha256(sql);
      const previous = done.get(file);

      if (previous !== undefined) {
        // تهجيرة مدمجة لا تُعدَّل: نرفض الإقلاع بدل تشغيل مخطط مختلف بصمت.
        // A merged migration must never change: refuse to boot rather than silently diverge.
        if (previous !== checksum) {
          throw new Error(`Migration ${file} was modified after being applied`);
        }
        result.skipped.push(file);
        continue;
      }

      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
          file,
          checksum,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
      result.applied.push(file);
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
    await pool.end();
  }
};
