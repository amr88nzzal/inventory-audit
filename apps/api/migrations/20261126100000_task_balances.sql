-- لقطة الرصيد النظري لكل مهمة جرد. A theoretical-balance snapshot per audit task.
--
-- اللقطة ثابتة وقت الجرد (تُرفع من CSV وتُستبدل كاملة ما دامت المهمة مسودة). المستودع هو مستودع المهمة.
-- الكمية بالوحدة الأساسية للصنف. The snapshot is fixed at audit time (uploaded from CSV, replaced wholesale while the
-- task is a draft). The warehouse is the task's warehouse. Quantity is in the item's base unit.
CREATE TABLE audit_task_balances (
  task_id     uuid NOT NULL REFERENCES audit_tasks (id),
  item_id     uuid NOT NULL REFERENCES items (id),
  company_id  uuid NOT NULL REFERENCES companies (id),
  quantity    numeric(18, 3) NOT NULL CHECK (quantity >= 0),
  PRIMARY KEY (task_id, item_id)
);

ALTER TABLE audit_task_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_task_balances FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_task_balances
  FOR ALL TO inventory_app
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, DELETE ON audit_task_balances TO inventory_app;

-- تتبّع آخر رفع: متى ومن وكم صفاً. Last upload tracking: when, by whom, how many rows.
ALTER TABLE audit_tasks
  ADD COLUMN balances_uploaded_at timestamptz,
  ADD COLUMN balances_uploaded_by uuid,
  ADD COLUMN balances_count integer NOT NULL DEFAULT 0;
