-- إنشاء الشركات الحقيقية من مدير المنصة، وإلزامية رمز الدخول (Contract بعد Expand).
-- Real company creation by the platform admin, and a mandatory login code (Contract after Expand).
--
-- لماذا: أضاف د-1 سياسة إدخال للشركات التجريبية فقط. الآن يحتاج مدير المنصة إنشاء شركات حقيقية،
-- فنستبدلها بسياسة إدخال عامة؛ أما UPDATE فيبقى للشركات التجريبية وحدها.
-- Why: d-1 allowed inserting demo companies only. The platform admin now creates real ones, so we
-- replace that with a general insert policy; UPDATE stays confined to demo companies.
DROP POLICY platform_demo_insert ON companies;
CREATE POLICY platform_insert ON companies
  FOR INSERT TO inventory_platform
  WITH CHECK (true);

-- لا توجد شركات بلا رمز في أي بيئة (الشركات لم تكن تُنشأ إلا بالاختبارات)، فالإلزام آمن.
-- No company without a code exists in any environment (only tests created companies), so NOT NULL is safe.
ALTER TABLE companies ALTER COLUMN code SET NOT NULL;
