-- التهجيرة الأولى: الشركات والمستخدمون مع عزل صفوف (RLS) بين الشركات.
-- First migration: companies and users with row-level security (RLS) between tenants.
--
-- لا تُعدَّل هذه الملفات بعد دمجها؛ أي تغيير يكون تهجيرة جديدة (Expand → Contract).
-- Never edit this file after it is merged; changes go in a new migration (Expand → Contract).

-- دور التطبيق: غير مالك للجداول ولا يتجاوز RLS. withTenant يبدّل إليه بـ SET LOCAL ROLE،
-- فيبقى العزل مفروضاً حتى لو اتصل التطبيق بحساب أقوى. في الإنتاج يُنشأ حساب دخول عضو فيه.
-- The app role: not a table owner and cannot bypass RLS. withTenant switches to it via
-- SET LOCAL ROLE, so isolation holds even if the app connects with a stronger account.
-- In production an ops-created login role is made a member of it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inventory_app') THEN
    CREATE ROLE inventory_app NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

CREATE TABLE companies (
  id          uuid PRIMARY KEY,
  name        text NOT NULL CHECK (length(btrim(name)) > 0),
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid,
  deleted_at  timestamptz
);

CREATE TABLE users (
  id            uuid PRIMARY KEY,
  company_id    uuid NOT NULL REFERENCES companies (id),
  username      text NOT NULL CHECK (length(btrim(username)) > 0),
  display_name  text NOT NULL CHECK (length(btrim(display_name)) > 0),
  active        boolean NOT NULL DEFAULT true,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_by    uuid,
  deleted_at    timestamptz
);

-- فهرس جزئي: اسم المستخدم فريد داخل الشركة بين السجلات غير المحذوفة فقط.
-- Partial unique index: username is unique per company among non-deleted rows only.
CREATE UNIQUE INDEX users_company_username_uq
  ON users (company_id, lower(username))
  WHERE deleted_at IS NULL;

CREATE INDEX users_company_idx ON users (company_id) WHERE deleted_at IS NULL;

-- RLS: ENABLE ثم FORCE كي يسري حتى على مالك الجدول.
-- RLS: ENABLE then FORCE so it also applies to the table owner.
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies FORCE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

-- نقرأ السياق بـ NULLIF لأن القيمة بعد نهاية المعاملة قد تصبح نصاً فارغاً لا NULL.
-- غياب السياق يعني NULL فلا يُطابق أي صف (فشل مغلق).
-- NULLIF because the GUC may read back as '' (not NULL) after a transaction ends.
-- A missing context yields NULL, which matches no row (fail closed).
CREATE FUNCTION app_company_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.company_id', true), '')::uuid $$;

-- الشركة: يرى التطبيق شركته فقط، ولا ينشئ شركات (الإنشاء مسار نظام منفصل لاحقاً).
-- Companies: the app sees only its own company and cannot create companies
-- (creation is a separate system path, added later).
CREATE POLICY tenant_isolation ON companies
  FOR ALL TO inventory_app
  USING (id = app_company_id())
  WITH CHECK (id = app_company_id());

-- WITH CHECK يمنع إدخال أو نقل سجل إلى شركة أخرى (mass assignment).
-- WITH CHECK blocks inserting or moving a row into another tenant (mass assignment).
CREATE POLICY tenant_isolation ON users
  FOR ALL TO inventory_app
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

-- صلاحيات دنيا: لا DELETE (الحذف ناعم)، ولا INSERT على companies.
-- Minimal grants: no DELETE (soft delete only), no INSERT on companies.
GRANT USAGE ON SCHEMA public TO inventory_app;
GRANT SELECT, UPDATE ON companies TO inventory_app;
GRANT SELECT, INSERT, UPDATE ON users TO inventory_app;
GRANT EXECUTE ON FUNCTION app_company_id() TO inventory_app;
