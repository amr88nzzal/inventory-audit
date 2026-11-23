import { jwtVerify, SignJWT } from 'jose';

// ثلاثة أنواع توكن بجمهور (aud) مختلف لكل منها، فلا يصلح أحدها مكان الآخر ولا مكان توكن الشركات:
//   access = الوصول لواجهة المنصة · mfa = بعد كلمة المرور بانتظار TOTP · enroll = بانتظار ربط TOTP.
// Three token kinds, each with its own audience, so none works in place of another or of a company token:
//   access = platform API · mfa = after the password, awaiting TOTP · enroll = awaiting TOTP enrollment.

export type PlatformTokenPurpose = 'access' | 'mfa' | 'enroll';

const ISSUER = 'inventory-audit';
const AUDIENCE: Record<PlatformTokenPurpose, string> = {
  access: 'inventory-audit:platform-api',
  mfa: 'inventory-audit:platform-mfa',
  enroll: 'inventory-audit:platform-enroll',
};
// عمر مرحلتي الدخول قصير؛ عمر الوصول من الإعدادات.
// The two sign-in steps are short-lived; the access lifetime comes from configuration.
const STEP_TTL_SECONDS = { mfa: 5 * 60, enroll: 10 * 60 } as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PlatformClaims {
  adminId: string;
  /** نسخة التوكن؛ يتغير بتغيير كلمة المرور فتبطل القديمة. Token version; changes with the password, voiding old tokens. */
  tokenVersion: number;
}

export interface PlatformTokenService {
  sign: (
    purpose: PlatformTokenPurpose,
    claims: PlatformClaims,
    now?: Date,
  ) => Promise<{ token: string; expiresAt: Date }>;
  verify: (purpose: PlatformTokenPurpose, token: string) => Promise<PlatformClaims | null>;
}

export const createPlatformTokenService = (
  secret: string,
  accessTtlMinutes: number,
): PlatformTokenService => {
  const key = new TextEncoder().encode(secret);
  const ttl = (purpose: PlatformTokenPurpose): number =>
    purpose === 'access' ? accessTtlMinutes * 60 : STEP_TTL_SECONDS[purpose];

  return {
    sign: async (purpose, claims, now = new Date()) => {
      const iat = Math.floor(now.getTime() / 1000);
      const exp = iat + ttl(purpose);
      const token = await new SignJWT({ tv: claims.tokenVersion })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(claims.adminId)
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE[purpose])
        .setIssuedAt(iat)
        .setExpirationTime(exp)
        .sign(key);
      return { token, expiresAt: new Date(exp * 1000) };
    },

    verify: async (purpose, token) => {
      try {
        const { payload } = await jwtVerify(token, key, {
          issuer: ISSUER,
          audience: AUDIENCE[purpose],
          algorithms: ['HS256'],
        });
        const adminId = payload.sub;
        const tv = payload['tv'];
        if (typeof adminId !== 'string' || !UUID_RE.test(adminId)) return null;
        if (typeof tv !== 'number' || !Number.isInteger(tv) || tv < 1) return null;
        return { adminId, tokenVersion: tv };
      } catch {
        return null;
      }
    },
  };
};
