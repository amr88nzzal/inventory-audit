-- المستودعات والمواقع ونطاق وصول المستخدم بالمستودعات (warehouseScope).
-- Warehouses, locations and a user's warehouse scope.
--
-- نطاق المستخدم: لا صفوف في user_warehouses = كل المستودعات؛ وجود صفوف = هذه فقط.
-- User scope: no rows in user_warehouses = every warehouse; any rows = only those.

-- بحث عربي مطبَّع بالتشابه الثلاثي (search_text يُعبَّأ من التطبيق بـ normalizeSearch).
-- Normalized Arabic search with trigrams (search_text is filled by the app with normalizeSearch).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE warehouses (
  id          uuid PRIMARY KEY,
  company_id  uuid NOT NULL REFERENCES companies (id),
  code        text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$'),
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  search_text text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid,
  deleted_at  timestamptz
);
CREATE UNIQUE INDEX warehouses_company_code_uq ON warehouses (company_id, lower(code)) WHERE deleted_at IS NULL;
CREATE INDEX warehouses_search_trgm ON warehouses USING gin (search_text gin_trgm_ops) WHERE deleted_at IS NULL;

CREATE TABLE locations (
  id           uuid PRIMARY KEY,
  company_id   uuid NOT NULL REFERENCES companies (id),
  warehouse_id uuid NOT NULL REFERENCES warehouses (id),
  code         text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$'),
  name         text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  active       boolean NOT NULL DEFAULT true,
  version      integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_by   uuid,
  deleted_at   timestamptz
);
CREATE UNIQUE INDEX locations_warehouse_code_uq ON locations (warehouse_id, lower(code)) WHERE deleted_at IS NULL;
CREATE INDEX locations_warehouse_idx ON locations (warehouse_id) WHERE deleted_at IS NULL;

CREATE TABLE user_warehouses (
  user_id      uuid NOT NULL REFERENCES users (id),
  warehouse_id uuid NOT NULL REFERENCES warehouses (id),
  company_id   uuid NOT NULL REFERENCES companies (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  PRIMARY KEY (user_id, warehouse_id)
);
CREATE INDEX user_warehouses_warehouse_idx ON user_warehouses (warehouse_id);

ALTER TABLE warehouses ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouses FORCE ROW LEVEL SECURITY;
ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE locations FORCE ROW LEVEL SECURITY;
ALTER TABLE user_warehouses ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_warehouses FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON warehouses
  FOR ALL TO inventory_app
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());
CREATE POLICY tenant_isolation ON locations
  FOR ALL TO inventory_app
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());
CREATE POLICY tenant_isolation ON user_warehouses
  FOR ALL TO inventory_app
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

-- حذف ناعم للمستودعات والمواقع (لا DELETE)؛ جدول النطاق يُستبدل محتواه فيحتاج DELETE.
-- Warehouses and locations are soft-deleted (no DELETE); the scope table is replaced wholesale so it needs DELETE.
GRANT SELECT, INSERT, UPDATE ON warehouses TO inventory_app;
GRANT SELECT, INSERT, UPDATE ON locations TO inventory_app;
GRANT SELECT, INSERT, DELETE ON user_warehouses TO inventory_app;
