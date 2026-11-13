import { jwtVerify, SignJWT } from 'jose';

// الهوية فقط في التوكن (userId, companyId)؛ الصلاحيات تُجلب من الخادم لا من التوكن.
// The token carries identity only (userId, companyId); permissions come from the server, not the token.

const ISSUER = 'inventory-audit';
// جمهور خاص بواجهة الشركات: توكن مدير المشروع لاحقاً سيحمل جمهوراً مختلفاً فلا يصلح هنا والعكس.
// An audience for the company API: the platform manager's token will use a different one later,
// so neither works on the other's routes.
const AUDIENCE = 'inventory-audit:company-api';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AccessClaims {
  userId: string;
  companyId: string;
  /** الجلسة التي أُصدر لها التوكن؛ إلغاؤها يُبطل التوكن فوراً. The session it was issued for; revoking it kills the token at once. */
  sessionId: string;
}

export interface IssuedToken {
  token: string;
  expiresAt: Date;
}

export interface TokenService {
  sign: (claims: AccessClaims, now?: Date) => Promise<IssuedToken>;
  /** null عند أي فشل، دون كشف السبب. null on any failure, without revealing why. */
  verify: (token: string) => Promise<AccessClaims | null>;
}

export const createTokenService = (secret: string, ttlSeconds: number): TokenService => {
  const key = new TextEncoder().encode(secret);

  return {
    sign: async (claims, now = new Date()) => {
      const iat = Math.floor(now.getTime() / 1000);
      const exp = iat + ttlSeconds;
      const token = await new SignJWT({ cid: claims.companyId, sid: claims.sessionId })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(claims.userId)
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt(iat)
        .setExpirationTime(exp)
        .sign(key);
      return { token, expiresAt: new Date(exp * 1000) };
    },

    verify: async (token) => {
      try {
        // نحدد الخوارزمية صراحة فلا يُقبل alg=none ولا خوارزمية مختلفة.
        // The algorithm is pinned so alg=none or any other algorithm is rejected.
        const { payload } = await jwtVerify(token, key, {
          issuer: ISSUER,
          audience: AUDIENCE,
          algorithms: ['HS256'],
        });
        const userId = payload.sub;
        const companyId = payload['cid'];
        const sessionId = payload['sid'];
        if (typeof userId !== 'string' || !UUID_RE.test(userId)) return null;
        if (typeof companyId !== 'string' || !UUID_RE.test(companyId)) return null;
        if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) return null;
        return { userId, companyId, sessionId };
      } catch {
        return null;
      }
    },
  };
};
