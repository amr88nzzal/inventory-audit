-- الأدوار والصلاحيات (RBAC). كتالوج الصلاحيات في الكود (packages/shared)؛ القاعدة تخزّن أي الصلاحيات
-- لكل دور فقط. دور المدير النظامي (`admin`) يملك كل صلاحيات الكتالوج ضمنياً بلا صفوف، فلا يحتاج
-- منحاً عند إضافة صلاحية جديدة.
-- Roles and permissions (RBAC). The permission catalog lives in code (packages/shared); the database
-- only stores which permissions each role holds. The system `admin` role holds every catalog
-- permission implicitly with no rows, so a new permission never needs granting to it.

CREATE TABLE roles (
  id          uuid PRIMARY KEY,
  company_id  uuid NOT NULL REFERENCES companies (id),
  -- رمز ثابت للأدوار النظامية (admin)، وNULL للأدوار المخصصة.
  -- A stable code for system roles (admin); NULL for custom roles.
  code        text,
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 64),
  description text CHECK (length(description) <= 500),
  is_system   boolean NOT NULL DEFAULT false,
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid,
  deleted_at  timestamptz,
  CHECK (is_system = (code IS NOT NULL))
);

CREATE UNIQUE INDEX roles_company_name_uq ON roles (company_id, lower(name)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX roles_company_code_uq ON roles (company_id, code) WHERE deleted_at IS NULL AND code IS NOT NULL;

CREATE TABLE role_permissions (
  role_id    uuid NOT NULL REFERENCES roles (id),
  company_id uuid NOT NULL REFERENCES companies (id),
  -- الصيغة الوحدة.المورد.الفعل؛ التحقق من وجودها في الكتالوج في التطبيق (الكتالوج يتغير بالكود).
  -- Format module.resource.action; membership in the catalog is checked by the app (the catalog changes with code).
  permission text NOT NULL CHECK (permission ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  PRIMARY KEY (role_id, permission)
);

CREATE TABLE user_roles (
  user_id    uuid NOT NULL REFERENCES users (id),
  role_id    uuid NOT NULL REFERENCES roles (id),
  company_id uuid NOT NULL REFERENCES companies (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  PRIMARY KEY (user_id, role_id)
);

CREATE INDEX user_roles_role_idx ON user_roles (role_id);

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON roles
  FOR ALL TO inventory_app
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());
CREATE POLICY tenant_isolation ON role_permissions
  FOR ALL TO inventory_app
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());
CREATE POLICY tenant_isolation ON user_roles
  FOR ALL TO inventory_app
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

-- الأدوار حذفها ناعم (لا DELETE)؛ جدولا الربط يُستبدل محتواهما فيحتاجان DELETE (لا سجل أعمال فيهما).
-- Roles are soft-deleted (no DELETE); the two link tables are replaced wholesale so they need DELETE
-- (they hold no business records).
GRANT SELECT, INSERT, UPDATE ON roles TO inventory_app;
GRANT SELECT, INSERT, DELETE ON role_permissions TO inventory_app;
GRANT SELECT, INSERT, DELETE ON user_roles TO inventory_app;
