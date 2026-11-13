-- الجلسات وتوكنات التحديث الدوّارة.
-- Sessions and rotating refresh tokens.
--
-- جلسة واحدة لكل تسجيل دخول (تمثّل «العائلة» family): كل تحديث يُصدر توكناً جديداً ويستهلك السابق.
-- إن عاد توكن مستهلك للظهور فهذا يعني نسخة مسروقة، فتُلغى الجلسة كلها.
-- One session per login (the "family"): every refresh issues a new token and consumes the old one.
-- If a consumed token shows up again it is a stolen copy, so the whole session is revoked.
--
-- لا حذف ناعم ولا created_by هنا عمداً: هذه حالة تشغيلية لا سجلات أعمال؛ الإلغاء بـ revoked_at
-- ويبقى الصف للتدقيق، والتنظيف الدوري مهمة لاحقة (لذلك لا صلاحية DELETE).
-- No soft delete or created_by on purpose: this is operational state, not business records;
-- revocation is revoked_at and the row stays for audit. Periodic cleanup is a later job (hence no DELETE grant).

CREATE TABLE sessions (
  id             uuid PRIMARY KEY,
  company_id     uuid NOT NULL REFERENCES companies (id),
  user_id        uuid NOT NULL REFERENCES users (id),
  user_agent     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz NOT NULL DEFAULT now(),
  -- عمر مطلق: لا تتجدد الجلسة بعده مهما استُعملت. Absolute lifetime: no renewal past it, however active.
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  revoked_reason text CHECK (revoked_reason IN ('logout', 'logout_all', 'reuse', 'password_changed'))
);

CREATE INDEX sessions_user_idx ON sessions (company_id, user_id) WHERE revoked_at IS NULL;

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY,
  company_id  uuid NOT NULL REFERENCES companies (id),
  session_id  uuid NOT NULL REFERENCES sessions (id),
  -- sha256 للسر؛ لا يُخزَّن التوكن نفسه فلا يفيد تسريب القاعدة.
  -- sha256 of the secret; the token itself is never stored, so a database leak does not yield usable tokens.
  token_hash  text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);

CREATE INDEX refresh_tokens_session_idx ON refresh_tokens (session_id);

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON sessions
  FOR ALL TO inventory_app
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

CREATE POLICY tenant_isolation ON refresh_tokens
  FOR ALL TO inventory_app
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

GRANT SELECT, INSERT, UPDATE ON sessions TO inventory_app;
GRANT SELECT, INSERT, UPDATE ON refresh_tokens TO inventory_app;
