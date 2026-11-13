import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import type { Database } from './schema';

// خطأ على اتصال خامل أو قيد الإغلاق (إعادة تشغيل القاعدة، قطع الشبكة) يصدر كحدث 'error'؛
// دون مستمع يُسقط العملية كلها. نسجّله ونترك الـ pool يستبدل الاتصال عند الحاجة.
// An error on an idle or closing connection (database restart, network drop) is emitted as an
// 'error' event; without a listener it crashes the whole process. We log it and let the pool
// replace the connection on demand.
const logPoolError = (err: Error): void => {
  console.error(JSON.stringify({ level: 'error', msg: 'database pool error', error: err.message }));
};

export const createDb = (
  connectionString: string,
  options: { max?: number } = {},
): Kysely<Database> => {
  const pool = new Pool({ connectionString, max: options.max ?? 10 });
  pool.on('error', logPoolError);
  pool.on('connect', (client) => client.on('error', logPoolError));
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
};

// معرّفات UUIDv7 مولَّدة في التطبيق: مرتبة زمنياً فتناسب الفهارس.
// App-generated UUIDv7 ids: time-ordered, which is index-friendly.
export const newId = (): string => uuidv7();
