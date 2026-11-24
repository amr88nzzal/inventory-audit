-- الأصناف ووحدات القياس المتعددة. Items and multiple units of measure.
--
-- الكمية الأساسية = المعدودة × معامل الوحدة (القطعة الأساسية معاملها 1 ضمناً ولا صف لها).
-- Base quantity = counted × the unit's factor (the base unit has factor 1 implicitly and no row).
-- الفئة والمورد نصان حران الآن (يكفيان للفلترة)؛ يُرقّيان إلى جدول مرجعي عند الحاجة إلى إدارتهما.
-- Category and supplier are free text for now (enough to filter); promote to reference tables when they need managing.

CREATE TABLE items (
  id            uuid PRIMARY KEY,
  company_id    uuid NOT NULL REFERENCES companies (id),
  barcode       text NOT NULL CHECK (barcode ~ '^[^\s[:cntrl:]]{1,64}$'),
  sku           text CHECK (length(btrim(sku)) BETWEEN 1 AND 120),
  name          text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  search_text   text NOT NULL,
  price         numeric(18, 4) CHECK (price >= 0),
  supplier      text CHECK (length(btrim(supplier)) BETWEEN 1 AND 120),
  category      text CHECK (length(btrim(category)) BETWEEN 1 AND 120),
  account_no    text CHECK (length(btrim(account_no)) BETWEEN 1 AND 120),
  base_unit     text NOT NULL DEFAULT 'قطعة' CHECK (length(btrim(base_unit)) BETWEEN 1 AND 120),
  -- نسبة تفاوت خاصة بالصنف تتقدم على نسبة المهمة (NULL = لا نسبة خاصة).
  -- A per-item tolerance that overrides the task's (NULL = none).
  tolerance_pct numeric(7, 4) CHECK (tolerance_pct BETWEEN 0 AND 100),
  active        boolean NOT NULL DEFAULT true,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_by    uuid,
  deleted_at    timestamptz
);
-- الباركود فريد داخل الشركة بين الأصناف الحية، والرمز المستودعي كذلك إن وُجد.
-- A barcode is unique within the company among live items; so is the warehouse code when present.
CREATE UNIQUE INDEX items_company_barcode_uq ON items (company_id, barcode) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX items_company_sku_uq ON items (company_id, lower(sku)) WHERE deleted_at IS NULL AND sku IS NOT NULL;
CREATE INDEX items_search_trgm ON items USING gin (search_text gin_trgm_ops) WHERE deleted_at IS NULL;
CREATE INDEX items_company_category_idx ON items (company_id, category) WHERE deleted_at IS NULL;
CREATE INDEX items_company_supplier_idx ON items (company_id, supplier) WHERE deleted_at IS NULL;

CREATE TABLE item_units (
  id         uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies (id),
  item_id    uuid NOT NULL REFERENCES items (id),
  name       text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  factor     numeric(18, 6) NOT NULL CHECK (factor > 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
CREATE UNIQUE INDEX item_units_item_name_uq ON item_units (item_id, lower(name));

ALTER TABLE items ENABLE ROW LEVEL SECURITY;
ALTER TABLE items FORCE ROW LEVEL SECURITY;
ALTER TABLE item_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_units FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON items
  FOR ALL TO inventory_app
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());
CREATE POLICY tenant_isolation ON item_units
  FOR ALL TO inventory_app
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

-- الأصناف حذفها ناعم؛ الوحدات تُستبدل مجموعتها كاملة عند التعديل فتحتاج DELETE (لا سجل أعمال فيها).
-- Items are soft-deleted; units are replaced as a set on update so they need DELETE (no business records in them).
GRANT SELECT, INSERT, UPDATE ON items TO inventory_app;
GRANT SELECT, INSERT, DELETE ON item_units TO inventory_app;
