import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// تشفير الحقول الحساسة (AES-256-GCM) بمعرّف مفتاح، فيمكن تدوير المفاتيح: يُشفَّر بالحالي ويُفك
// بأي مفتاح قديم ما دام مضبوطاً. السياق (AAD) يربط النص المشفّر بصاحبه فلا يُنقل بين صفوف أو حقول.
// Field encryption (AES-256-GCM) with a key id, so keys can be rotated: encrypt with the current
// key and decrypt with any older one still configured. The context (AAD) binds a ciphertext to its
// owner so it cannot be moved between rows or fields.

export interface EncryptionKeys {
  keys: ReadonlyMap<string, Buffer>;
  currentKeyId: string;
}

export interface FieldCrypto {
  encrypt: (plaintext: string, context: string) => string;
  /** يرمي عند أي عبث أو سياق أو مفتاح خاطئ. Throws on tampering or a wrong context or key. */
  decrypt: (payload: string, context: string) => string;
}

const VERSION = 'v1';

export const createFieldCrypto = ({ keys, currentKeyId }: EncryptionKeys): FieldCrypto => {
  if (!keys.has(currentKeyId)) throw new Error(`Unknown current encryption key: ${currentKeyId}`);

  return {
    encrypt: (plaintext, context) => {
      const key = keys.get(currentKeyId)!;
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(context, 'utf8'));
      const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [VERSION, currentKeyId, iv, ct, tag]
        .map((p) => (Buffer.isBuffer(p) ? p.toString('base64url') : p))
        .join(':');
    },

    decrypt: (payload, context) => {
      const [version, keyId, iv, ct, tag, ...rest] = payload.split(':');
      if (version !== VERSION || !keyId || !iv || !ct || !tag || rest.length > 0) {
        throw new Error('Malformed ciphertext');
      }
      const key = keys.get(keyId);
      if (!key) throw new Error(`Unknown encryption key: ${keyId}`);
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAAD(Buffer.from(context, 'utf8'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(ct, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    },
  };
};

const KEY_ID_RE = /^[a-z0-9_-]{1,16}$/;

/** يحلل `k1:<base64>,k2:<base64>`؛ يعيد الأخطاء نصاً. Parses `k1:<base64>,k2:<base64>`; returns errors as text. */
export const parseEncryptionKeys = (
  raw: string | undefined,
  currentKeyId: string | undefined,
): { value: EncryptionKeys | null; errors: string[] } => {
  const errors: string[] = [];
  if (!raw) return { value: null, errors: ['ENCRYPTION_KEYS is required'] };

  const keys = new Map<string, Buffer>();
  for (const entry of raw.split(',')) {
    const sep = entry.indexOf(':');
    const id = entry.slice(0, sep).trim();
    const b64 = entry.slice(sep + 1).trim();
    if (sep < 1 || !KEY_ID_RE.test(id)) {
      errors.push('ENCRYPTION_KEYS entries must look like <id>:<base64> (id: a-z, 0-9, _ or -)');
      continue;
    }
    const key = Buffer.from(b64, 'base64');
    if (key.length !== 32) {
      errors.push(`Encryption key ${id} must be exactly 32 bytes (base64 of 32 random bytes)`);
    } else if (new Set(key).size < 8) {
      errors.push(`Encryption key ${id} looks non-random`);
    } else if (keys.has(id)) {
      errors.push(`Duplicate encryption key id: ${id}`);
    } else {
      keys.set(id, key);
    }
  }
  if (!currentKeyId) errors.push('ENCRYPTION_KEY_ID is required');
  else if (!keys.has(currentKeyId))
    errors.push('ENCRYPTION_KEY_ID must name a key in ENCRYPTION_KEYS');

  return errors.length > 0
    ? { value: null, errors }
    : { value: { keys, currentKeyId: currentKeyId! }, errors };
};
