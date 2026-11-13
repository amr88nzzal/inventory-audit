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
