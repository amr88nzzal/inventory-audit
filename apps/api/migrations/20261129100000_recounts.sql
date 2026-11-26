-- إعادة العدّ: طلب من المشرف لأصناف مختارة يعدّها مراجع ثانٍ، فيحلّ عدّه محل العدّ السابق دون حذف شيء.
-- Recount: a supervisor asks a second reviewer to count chosen items again; the new count replaces the old one in the result, nothing is deleted.
-- Expand فقط. Expand only.

-- الجولة: 1 للعدّ الأول، وتزيد مع كل إعادة عدّ للصنف. Round: 1 for the first count, bumped by each recount of an item.
ALTER TABLE audit_records ADD COLUMN round integer NOT NULL DEFAULT 1 CHECK (round >= 1);
ALTER TABLE audit_task_results ADD COLUMN round integer NOT NULL DEFAULT 1 CHECK (round >= 1);

CREATE TABLE audit_recounts (
  id           uuid PRIMARY KEY,
  company_id   uuid NOT NULL REFERENCES companies (id),
  task_id      uuid NOT NULL REFERENCES audit_tasks (id),
  item_id      uuid NOT NULL REFERENCES items (id),
  round        integer NOT NULL CHECK (round >= 2),
  assignee_id  uuid NOT NULL REFERENCES users (id),
  requested_by uuid NOT NULL REFERENCES users (id),
  reason       text CHECK (reason IS NULL OR length(reason) <= 300),
  requested_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, item_id, round)
);
CREATE INDEX audit_recounts_task_idx ON audit_recounts (task_id, item_id);
CREATE INDEX audit_recounts_assignee_idx ON audit_recounts (task_id, assignee_id);

ALTER TABLE audit_recounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_recounts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_recounts FOR ALL TO inventory_app
  USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
-- طلبات إعادة العدّ للإضافة فقط. Recount requests are append-only.
GRANT SELECT, INSERT ON audit_recounts TO inventory_app;
CREATE TRIGGER audit_recounts_no_change BEFORE UPDATE OR DELETE ON audit_recounts
  FOR EACH ROW EXECUTE FUNCTION frozen_results_immutable();
