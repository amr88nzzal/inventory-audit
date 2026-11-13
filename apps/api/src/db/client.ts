import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import type { Database } from './schema';

export const createDb = (
  connectionString: string,
  options: { max?: number } = {},
): Kysely<Database> =>
  new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString, max: options.max ?? 10 }),
    }),
  });

// معرّفات UUIDv7 مولَّدة في التطبيق: مرتبة زمنياً فتناسب الفهارس.
// App-generated UUIDv7 ids: time-ordered, which is index-friendly.
export const newId = (): string => uuidv7();
