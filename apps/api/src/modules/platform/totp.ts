import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// TOTP (RFC 6238) بـ HMAC-SHA1 و6 أرقام وخطوة 30 ثانية: ما تدعمه كل تطبيقات المصادقة.
// مكتوب بلا اعتمادية خارجية لأنه قصير وله متجهات اختبار رسمية.
// TOTP (RFC 6238) with HMAC-SHA1, 6 digits and a 30-second step: what every authenticator app supports.
// Written without an external dependency because it is short and has official test vectors.

const STEP_SECONDS = 30;
const DIGITS = 6;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const base32Encode = (buf: Buffer): string => {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
};

export const base32Decode = (text: string): Buffer => {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text.replace(/=+$/, '').toUpperCase()) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
};

/** سر عشوائي 160 بتاً (الحجم الموصى به في RFC 4226). A 160-bit random secret (RFC 4226's recommended size). */
export const generateTotpSecret = (): string => base32Encode(randomBytes(20));

const hotp = (key: Buffer, counter: number, digits = DIGITS): string => {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', key).update(msg).digest();
  const offset = h[h.length - 1]! & 0x0f;
  const bin =
    ((h[offset]! & 0x7f) << 24) | (h[offset + 1]! << 16) | (h[offset + 2]! << 8) | h[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
};

export const stepAt = (nowMs: number): number => Math.floor(nowMs / 1000 / STEP_SECONDS);

export const totpAt = (secretBase32: string, nowMs: number, digits = DIGITS): string =>
  hotp(base32Decode(secretBase32), stepAt(nowMs), digits);

/**
 * يتحقق من الرمز ضمن نافذة ±خطوة (ساعة الجهاز قد تتأخر)، ويرفض أي خطوة <= آخر خطوة قُبلت
 * (منع إعادة الاستعمال). يعيد الخطوة المطابقة أو null.
 * Verifies a code within a ±1 step window (the device clock may drift) and rejects any step <= the
 * last accepted one (replay protection). Returns the matching step or null.
 */
export const verifyTotp = (
  secretBase32: string,
  code: string,
  nowMs: number,
  lastAcceptedStep: number | null,
  window = 1,
): number | null => {
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secretBase32);
  const current = stepAt(nowMs);
  const given = Buffer.from(code);
  let matched: number | null = null;
  // نمرّ على كل النافذة دائماً (زمن ثابت تقريباً) ونقارن بمقارنة آمنة زمنياً.
  // Always walk the whole window (roughly constant time) and compare in constant time.
  for (let step = current - window; step <= current + window; step++) {
    const ok = timingSafeEqual(Buffer.from(hotp(key, step)), given);
    if (ok && (lastAcceptedStep === null || step > lastAcceptedStep) && matched === null) {
      matched = step;
    }
  }
  return matched;
};

export const otpauthUri = (issuer: string, account: string, secretBase32: string): string => {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const q = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${q.toString()}`;
};
