-- مهام الجرد وإسنادها للموظفين. Audit tasks and their assignees.
--
-- المهمة تخص مستودعاً واحداً. الحالات: draft → in_progress → closed، وcancelled من draft/in_progress.
-- A task belongs to one warehouse. States: draft → in_progress → closed, and cancelled from draft/in_progress.

-- عدّاد رقم المهمة لكل شركة (رقم متسلسل مقروء للبشر يظهر في التقارير).
-- A per-company task number counter (a human-readable sequence shown in reports).
CREATE TABLE audit_task_counters (
  company_id uuid PRIMARY KEY REFERENCES companies (id),
  last_no    integer NOT NULL DEFAULT 0
);

CREATE TABLE audit_tasks (
  id                  uuid PRIMARY KEY,
  company_id          uuid NOT NULL REFERENCES companies (id),
  task_no             integer NOT NULL,
  title               text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  warehouse_id        uuid NOT NULL REFERENCES warehouses (id),
  status              text NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'in_progress', 'closed', 'cancelled')),
  starts_at           timestamptz,
  -- العد الأعمى: يُخفي الرصيد النظري عن الموظف. Blind count: hides the system balance from the employee.
  blind_count         boolean NOT NULL DEFAULT false,
  -- تجميع الكميات من المواقع المتعددة تلقائياً أم بالتسلسل. Auto-sum an item across locations, or keep input order.
  aggregate_locations boolean NOT NULL DEFAULT true,
  notes               text CHECK (notes IS NULL OR length(notes) <= 1000),
  started_at          timestamptz,
  closed_at           timestamptz,
  cancelled_at        timestamptz,
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_by          uuid,
  deleted_at          timestamptz
);
CREATE UNIQUE INDEX audit_tasks_company_no_uq ON audit_tasks (company_id, task_no);
CREATE INDEX audit_tasks_warehouse_idx ON audit_tasks (warehouse_id) WHERE deleted_at IS NULL;
CREATE INDEX audit_tasks_status_idx ON audit_tasks (company_id, status) WHERE deleted_at IS NULL;

CREATE TABLE audit_task_assignees (
  task_id     uuid NOT NULL REFERENCES audit_tasks (id),
  user_id     uuid NOT NULL REFERENCES users (id),
  company_id  uuid NOT NULL REFERENCES companies (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  PRIMARY KEY (task_id, user_id)
);
CREATE INDEX audit_task_assignees_user_idx ON audit_task_assignees (user_id);

ALTER TABLE audit_task_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_task_counters FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_task_assignees ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_task_assignees FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON audit_task_counters
  FOR ALL TO inventory_app
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());
CREATE POLICY tenant_isolation ON audit_tasks
  FOR ALL TO inventory_app
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());
CREATE POLICY tenant_isolation ON audit_task_assignees
  FOR ALL TO inventory_app
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

-- المهام لا تُحذف (حذف ناعم/إلغاء)؛ المسندون يُستبدلون كاملاً فيحتاجون DELETE.
-- Tasks are never hard-deleted; assignees are replaced wholesale so they need DELETE.
GRANT SELECT, INSERT, UPDATE ON audit_task_counters TO inventory_app;
GRANT SELECT, INSERT, UPDATE ON audit_tasks TO inventory_app;
GRANT SELECT, INSERT, DELETE ON audit_task_assignees TO inventory_app;
