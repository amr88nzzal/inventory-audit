-- إغلاق مهمة الجرد: تفاوت المهمة، وتجميد النتيجة النهائية، ومفاتيح عدم التكرار للعمليات الحرجة.
-- Closing an audit task: the task tolerance, a frozen final result, and idempotency keys for critical operations.
-- Expand فقط: أعمدة وجداول جديدة ولا شيء يُحذف. Expand only: new columns and tables, nothing dropped.

ALTER TABLE audit_tasks
  ADD COLUMN tolerance_pct numeric(7, 4) CHECK (tolerance_pct IS NULL OR tolerance_pct BETWEEN 0 AND 100),
  ADD COLUMN closed_by uuid,
  ADD COLUMN closing_note text CHECK (closing_note IS NULL OR length(closing_note) <= 1000);

-- النتيجة المجمَّدة عند الإغلاق: لا يغيّرها تعديل لاحق على الأصناف أو التفاوتات.
-- The result frozen at close: later edits to items or tolerances never change it.
CREATE TABLE audit_task_results (
  task_id               uuid NOT NULL REFERENCES audit_tasks (id),
  item_id               uuid NOT NULL REFERENCES items (id),
  company_id            uuid NOT NULL REFERENCES companies (id),
  counted               numeric(24, 6) NOT NULL,
  theoretical           numeric(24, 6) NOT NULL,
  difference            numeric(24, 6) NOT NULL,
  difference_pct        numeric(12, 2),
  status                text NOT NULL CHECK (status IN ('match', 'over', 'short')),
  applied_tolerance_pct numeric(7, 4) NOT NULL,
  flagged_for_recount   boolean NOT NULL,
  locations             jsonb,
  PRIMARY KEY (task_id, item_id)
);

CREATE TABLE audit_task_unknown (
  task_id    uuid NOT NULL REFERENCES audit_tasks (id),
  barcode    text NOT NULL,
  company_id uuid NOT NULL REFERENCES companies (id),
  quantity   numeric(24, 6) NOT NULL,
  records    integer NOT NULL,
  PRIMARY KEY (task_id, barcode)
);

-- مفاتيح عدم التكرار لعمليات الطلب الواحد (الإغلاق...). تخزَّن الاستجابة لإعادتها عند تكرار الطلب.
-- Idempotency keys for single-request operations (close...). The response is stored and replayed on a repeat.
CREATE TABLE idempotency_keys (
  company_id   uuid NOT NULL REFERENCES companies (id),
  user_id      uuid NOT NULL REFERENCES users (id),
  key          text NOT NULL CHECK (length(key) BETWEEN 8 AND 100),
  request_hash text NOT NULL,
  response     jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, user_id, key)
);

ALTER TABLE audit_task_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_task_results FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_task_unknown ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_task_unknown FORCE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_task_results FOR ALL TO inventory_app
  USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
CREATE POLICY tenant_isolation ON audit_task_unknown FOR ALL TO inventory_app
  USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
CREATE POLICY tenant_isolation ON idempotency_keys FOR ALL TO inventory_app
  USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());

-- النتائج المجمَّدة للإضافة فقط. The frozen results are append-only.
GRANT SELECT, INSERT ON audit_task_results, audit_task_unknown, idempotency_keys TO inventory_app;

CREATE FUNCTION frozen_results_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
CREATE TRIGGER audit_task_results_no_change BEFORE UPDATE OR DELETE ON audit_task_results
  FOR EACH ROW EXECUTE FUNCTION frozen_results_immutable();
CREATE TRIGGER audit_task_unknown_no_change BEFORE UPDATE OR DELETE ON audit_task_unknown
  FOR EACH ROW EXECUTE FUNCTION frozen_results_immutable();
