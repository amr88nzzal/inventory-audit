import type { AppConfig } from '../config';

// إعداد للاختبارات: تكلفة تجزئة دنيا للسرعة، وحدود معدّل عالية كي لا تتداخل مع الاختبارات
// (اختبار تحديد المعدل يخفضها صراحة).
// Test configuration: minimal hash cost for speed and high rate limits so they do not interfere
// (the rate-limit test lowers them explicitly).
export const testConfig = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  nodeEnv: 'test',
  port: 0,
  databaseUrl: 'postgres://unused:unused@127.0.0.1:1/unused',
  jwtSecret: 'test-only-jwt-key-0123456789-abcdefghijklmnopqrstuvwxyz',
  accessTokenTtlSeconds: 900,
  refreshTokenTtlDays: 30,
  sessionMaxDays: 90,
  passwordHashLogN: 10,
  loginMaxFailures: 5,
  loginLockMinutes: 15,
  rateLimit: { generalPerMinute: 100_000, loginPerWindow: 100_000, loginWindowMinutes: 15 },
  ...overrides,
});
