-- الشركة التجريبية: علامة is_demo وصلاحيات ضيقة لدور المنصة على الشركات التجريبية فقط.
-- The demo company: an is_demo flag and narrow platform-role privileges over demo companies only.
--
-- لماذا: أمر seed/reset-demo يعمل بدور المنصة ويجب ألا يستطيع لمس شركة حقيقية أبداً، فالسياسات
-- تحصر INSERT/UPDATE في الصفوف ذات is_demo = true. وإنشاء الشركات الحقيقية له مسار لاحق (1د-2).
-- Why: the seed/reset-demo command runs as the platform role and must never touch a real company,
-- so the policies confine INSERT/UPDATE to rows with is_demo = true. Real company creation has its own later path (1د-2).

ALTER TABLE companies ADD COLUMN is_demo boolean NOT NULL DEFAULT false;

-- الشركة التجريبية تُنقل لها كل الإعدادات لكن لا يغيّر مستأجر علامتها ولا رمزها: نقصر UPDATE
-- لدور التطبيق على الأعمدة التي يحتاجها فقط.
-- A tenant must not flip its own is_demo flag or code: narrow the app role's UPDATE to needed columns.
REVOKE UPDATE ON companies FROM inventory_app;
GRANT UPDATE (name, version, updated_at, updated_by) ON companies TO inventory_app;

GRANT SELECT, INSERT, UPDATE ON companies TO inventory_platform;

CREATE POLICY platform_read ON companies
  FOR SELECT TO inventory_platform
  USING (true);
CREATE POLICY platform_demo_insert ON companies
  FOR INSERT TO inventory_platform
  WITH CHECK (is_demo);
CREATE POLICY platform_demo_update ON companies
  FOR UPDATE TO inventory_platform
  USING (is_demo)
  WITH CHECK (is_demo);
