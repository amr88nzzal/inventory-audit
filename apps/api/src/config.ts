import { parseEncryptionKeys } from './crypto/encryption';
import type { EncryptionKeys } from './crypto/encryption';

// الإعدادات كلها من متغيرات البيئة، وتُتحقَّق عند الإقلاع: فشل سريع بدل التشغيل بإعداد خاطئ.
// All configuration comes from environment variables and is validated at boot: fail fast rather
// than run with a bad setup.

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  accessTokenTtlSeconds: number;
  /** مدة توكن التحديث (تتجدد بكل تحديث). Refresh token lifetime (renewed on each refresh). */
  refreshTokenTtlDays: number;
  /** عمر الجلسة المطلق. Absolute session lifetime. */
  sessionMaxDays: number;
  /** أُس تكلفة scrypt (N = 2^x). scrypt cost exponent (N = 2^x). */
  passwordHashLogN: number;
  loginMaxFailures: number;
  loginLockMinutes: number;
  /** مفاتيح تشفير الحقول الحساسة. Keys for encrypting sensitive fields. */
  encryption: EncryptionKeys;
  platform: {
    /** عمر توكن مدير المنصة بالدقائق (بلا Refresh: يعيد الدخول بعده). Platform token lifetime in minutes (no refresh: sign in again). */
    tokenTtlMinutes: number;
    /** إن لم تكن فارغة، غير هذه العناوين ترى 404 على /platform. When non-empty, other addresses get 404 on /platform. */
    allowedIps: string[];
    /** إنشاء أول مدير منصة عند الإقلاع إن كان الجدول فارغاً. Create the first platform admin at boot when the table is empty. */
    bootstrap: { username: string; password: string } | null;
  };
  rateLimit: {
    generalPerMinute: number;
    /** محاولات الدخول لكل (عنوان + شركة + مستخدم) في النافذة. Login attempts per (ip + company + user) per window. */
    loginPerWindow: number;
    loginWindowMinutes: number;
  };
}

const JWT_SECRET_MIN_LENGTH = 32;

// أنماط تدل على سر مكتوب بيد أو منسوخ من مثال، ومنها قيمة القديم الافتراضية.
// Patterns that indicate a hand-written or copied-from-example secret, including the old repo's default.
const PLACEHOLDER_PATTERNS = [
  'change-me',
  'changeme',
  'change-this',
  'secret',
  'password',
  'example',
  'default',
  '123456',
];

export const isWeakSecret = (secret: string): boolean => {
  const lower = secret.toLowerCase();
  if (PLACEHOLDER_PATTERNS.some((p) => lower.includes(p))) return true;
  // سر بتنوع حروف قليل (مثل aaaa...) ضعيف مهما طال.
  // A secret with few distinct characters (like aaaa...) is weak however long.
  return new Set(secret).size < 10;
};

const toInt = (
  raw: string | undefined,
  fallback: number,
  name: string,
  errors: string[],
): number => {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    errors.push(`${name} must be a positive integer`);
    return fallback;
  }
  return n;
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => {
  const errors: string[] = [];

  const rawEnv = env['NODE_ENV'];
  const nodeEnv =
    rawEnv === 'production' || rawEnv === 'test' || rawEnv === 'development'
      ? rawEnv
      : 'development';

  const databaseUrl = env['DATABASE_URL'];
  if (!databaseUrl) errors.push('DATABASE_URL is required');

  const jwtSecret = env['JWT_SECRET'] ?? '';
  if (jwtSecret.length < JWT_SECRET_MIN_LENGTH) {
    errors.push(`JWT_SECRET is required and must be at least ${JWT_SECRET_MIN_LENGTH} characters`);
  } else if (nodeEnv === 'production' && isWeakSecret(jwtSecret)) {
    errors.push('JWT_SECRET looks like a placeholder or is too repetitive; use a random value');
  }

  const passwordHashLogN = toInt(env['PASSWORD_HASH_LOG_N'], 17, 'PASSWORD_HASH_LOG_N', errors);
  if (passwordHashLogN < 10 || passwordHashLogN > 20) {
    errors.push('PASSWORD_HASH_LOG_N must be between 10 and 20');
  }
  if (nodeEnv === 'production' && passwordHashLogN < 15) {
    errors.push('PASSWORD_HASH_LOG_N must be at least 15 in production');
  }

  const enc = parseEncryptionKeys(env['ENCRYPTION_KEYS'], env['ENCRYPTION_KEY_ID']);
  errors.push(...enc.errors);

  const bootUser = env['PLATFORM_ADMIN_USERNAME']?.trim() ?? '';
  const bootPass = env['PLATFORM_ADMIN_PASSWORD'] ?? '';
  if ((bootUser === '') !== (bootPass === '')) {
    errors.push('PLATFORM_ADMIN_USERNAME and PLATFORM_ADMIN_PASSWORD must be set together');
  } else if (bootPass !== '' && bootPass.length < 12) {
    errors.push('PLATFORM_ADMIN_PASSWORD must be at least 12 characters');
  }

  const config: AppConfig = {
    nodeEnv,
    port: toInt(env['PORT'], 3000, 'PORT', errors),
    databaseUrl: databaseUrl ?? '',
    jwtSecret,
    accessTokenTtlSeconds: toInt(
      env['ACCESS_TOKEN_TTL_SECONDS'],
      900,
      'ACCESS_TOKEN_TTL_SECONDS',
      errors,
    ),
    refreshTokenTtlDays: toInt(env['REFRESH_TOKEN_TTL_DAYS'], 30, 'REFRESH_TOKEN_TTL_DAYS', errors),
    sessionMaxDays: toInt(env['SESSION_MAX_DAYS'], 90, 'SESSION_MAX_DAYS', errors),
    passwordHashLogN,
    loginMaxFailures: toInt(env['LOGIN_MAX_FAILURES'], 5, 'LOGIN_MAX_FAILURES', errors),
    loginLockMinutes: toInt(env['LOGIN_LOCK_MINUTES'], 15, 'LOGIN_LOCK_MINUTES', errors),
    encryption: enc.value ?? { keys: new Map(), currentKeyId: '' },
    platform: {
      tokenTtlMinutes: toInt(
        env['PLATFORM_TOKEN_TTL_MINUTES'],
        30,
        'PLATFORM_TOKEN_TTL_MINUTES',
        errors,
      ),
      allowedIps: (env['PLATFORM_ALLOWED_IPS'] ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
      bootstrap:
        bootUser !== '' && bootPass !== '' ? { username: bootUser, password: bootPass } : null,
    },
    rateLimit: {
      generalPerMinute: toInt(env['RATE_LIMIT_PER_MINUTE'], 300, 'RATE_LIMIT_PER_MINUTE', errors),
      loginPerWindow: toInt(env['RATE_LIMIT_LOGIN'], 10, 'RATE_LIMIT_LOGIN', errors),
      loginWindowMinutes: toInt(
        env['RATE_LIMIT_LOGIN_WINDOW_MINUTES'],
        15,
        'RATE_LIMIT_LOGIN_WINDOW_MINUTES',
        errors,
      ),
    },
  };

  if (config.refreshTokenTtlDays > config.sessionMaxDays) {
    errors.push('REFRESH_TOKEN_TTL_DAYS must not exceed SESSION_MAX_DAYS');
  }

  if (errors.length > 0) {
    throw new Error(`Invalid configuration:\n- ${errors.join('\n- ')}`);
  }
  return config;
};
