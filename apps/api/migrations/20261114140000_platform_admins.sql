-- مديرو المنصة (مدير المشروع): حسابات منفصلة تماماً عن مستخدمي الشركات، ودخولهم بكلمة مرور + TOTP.
-- Platform admins (the project manager): accounts fully separate from company users, signing in
-- with a password plus TOTP.
--
-- لا company_id ولا RLS هنا لأنهم فوق الشركات. الحماية بالصلاحيات: دور منفصل `inventory_platform`
-- وحده يقرأ الجدول ويكتبه، ودور التطبيق (inventory_app) لا يملك أي صلاحية عليه، فكود الشركات
-- لا يستطيع لمسه حتى لو حُقن فيه استعلام.
-- No company_id or RLS because they sit above companies. Protection is by privileges: a separate
-- `inventory_platform` role alone reads and writes the table, and the app role (inventory_app) has
-- no privilege on it, so company code cannot touch it even if a query were injected.
DO $$
BEGIN
  CREATE ROLE inventory_platform NOLOGIN NOBYPASSRLS;
EXCEPTION
  WHEN duplicate_object OR unique_violation THEN NULL;
END
$$;

CREATE TABLE platform_admins (
  id                   uuid PRIMARY KEY,
  username             text NOT NULL CHECK (length(btrim(username)) BETWEEN 3 AND 64),
  display_name         text NOT NULL CHECK (length(btrim(display_name)) > 0),
  password_hash        text NOT NULL,
  -- كلمة المرور المبدئية (من البيئة أو CLI) مؤقتة حتى يغيّرها صاحبها عند ربط التطبيق.
  -- The initial password (from the environment or the CLI) is temporary until its owner changes it at enrollment.
  must_change_password boolean NOT NULL DEFAULT true,
  active               boolean NOT NULL DEFAULT true,
  -- يزيد عند تغيير كلمة المرور أو إعادة التهيئة فتبطل كل التوكنات السابقة.
  -- Bumped on password change or reset, which invalidates every earlier token.
  token_version        integer NOT NULL DEFAULT 1,
  failed_login_count   integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until         timestamptz,
  -- السر مشفّر بـ AES-256-GCM في التطبيق (النص المشفّر لا السر).
  -- The secret is AES-256-GCM encrypted by the app (ciphertext, never the secret).
  totp_secret_enc      text,
  totp_enrolled_at     timestamptz,
  -- آخر خطوة زمنية قُبلت: يمنع إعادة استعمال الرمز نفسه (replay).
  -- The last accepted time step: prevents replaying the same code.
  totp_last_step       bigint,
  last_login_at        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (totp_enrolled_at IS NULL OR totp_secret_enc IS NOT NULL)
);

CREATE UNIQUE INDEX platform_admins_username_uq ON platform_admins (lower(username));

GRANT USAGE ON SCHEMA public TO inventory_platform;
GRANT SELECT, INSERT, UPDATE ON platform_admins TO inventory_platform;
REVOKE ALL ON platform_admins FROM PUBLIC;
