import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// scrypt من مكتبة Node نفسها: بلا اعتمادية أصلية، فتعمل على arm64 دون بناء إضافي.
// scrypt from Node itself: no native dependency, so it runs on arm64 without extra builds.
//
// الصيغة: scrypt$<logN>$<r>$<p>$<salt>$<hash>. المعاملات داخل الناتج، فيمكن رفع التكلفة لاحقاً
// وتبقى كلمات المرور القديمة قابلة للتحقق.
// Format: scrypt$<logN>$<r>$<p>$<salt>$<hash>. Parameters travel with the hash, so cost can be
// raised later while old hashes stay verifiable.

const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const MIN_LOG_N = 10;
const MAX_LOG_N = 20;

const derive = (
  password: string,
  salt: Buffer,
  logN: number,
  r: number,
  p: number,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const N = 2 ** logN;
    // الذاكرة اللازمة 128*N*r؛ نمنح هامشاً مضاعفاً كي لا تفشل scrypt بحد Node الافتراضي (32MB).
    // Memory needed is 128*N*r; we allow double headroom so scrypt does not hit Node's 32MB default.
    scrypt(password, salt, KEY_LENGTH, { N, r, p, maxmem: 256 * N * r }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });

export const hashPassword = async (password: string, logN: number): Promise<string> => {
  if (logN < MIN_LOG_N || logN > MAX_LOG_N) throw new RangeError('logN out of range');
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, logN, R, P);
  return `scrypt$${logN}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
};

// أي صيغة تالفة ترجع false بدل رمي خطأ، فلا يتحول سجل تالف إلى خطأ 500 يكشف حالة الحساب.
// Any malformed value returns false instead of throwing, so a corrupt row never becomes a 500 that leaks account state.
export const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, logNRaw, rRaw, pRaw, saltRaw, hashRaw] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const logN = Number(logNRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (![logN, r, p].every(Number.isInteger)) return false;
  if (logN < MIN_LOG_N || logN > MAX_LOG_N || r < 1 || r > 16 || p < 1 || p > 4) return false;

  const salt = Buffer.from(saltRaw, 'base64url');
  const expected = Buffer.from(hashRaw, 'base64url');
  if (salt.length === 0 || expected.length === 0) return false;

  const actual = await derive(password, salt, logN, r, p).catch(() => null);
  if (!actual || actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
};

// تجزئة وهمية بالتكلفة نفسها: عند غياب الشركة أو المستخدم نجري تحققاً مماثلاً كي لا يُعرف
// وجود الحساب من زمن الاستجابة.
// A dummy hash at the same cost: when the company or user is missing we run an equivalent
// verification so response time does not reveal whether the account exists.
const dummyHashes = new Map<number, Promise<string>>();

export const verifyAgainstDummy = async (password: string, logN: number): Promise<void> => {
  let pending = dummyHashes.get(logN);
  if (!pending) {
    pending = hashPassword('dummy-password-for-timing-equalization', logN);
    dummyHashes.set(logN, pending);
  }
  await verifyPassword(password, await pending);
};
