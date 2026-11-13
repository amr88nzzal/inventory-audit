-- بيانات الدخول: رمز الشركة، وأعمدة كلمة المرور والقفل للمستخدمين.
-- Login data: the company code, and password/lockout columns for users.
--
-- أسلوب Expand: الأعمدة الجديدة قابلة للإفراغ (nullable) أو بقيم افتراضية. تُشدَّد (NOT NULL) في
-- تهجيرة لاحقة بعد وجود مسار إنشاء الشركات الذي يملأ الرمز دائماً.
-- Expand style: new columns are nullable or defaulted. They are tightened (NOT NULL) in a later
-- migration, once the company-creation path that always fills the code exists.

ALTER TABLE companies ADD COLUMN code text;

-- رمز الشركة: أحرف صغيرة وأرقام وشرطة، 3 إلى 32، لا يبدأ ولا ينتهي بشرطة. NULL يمر من CHECK.
-- Company code: lowercase letters, digits and dashes, 3 to 32, never starting or ending with a dash.
-- NULL passes the CHECK.
ALTER TABLE companies
  ADD CONSTRAINT companies_code_format CHECK (code ~ '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$');

CREATE UNIQUE INDEX companies_code_uq ON companies (code) WHERE deleted_at IS NULL;

ALTER TABLE users
  ADD COLUMN password_hash        text,
  -- true افتراضياً: كل كلمة مرور تُنشأ من الإدارة مؤقتة حتى يغيّرها صاحبها.
  -- true by default: any password set by an admin is temporary until its owner changes it.
  ADD COLUMN must_change_password boolean NOT NULL DEFAULT true,
  ADD COLUMN password_changed_at  timestamptz,
  ADD COLUMN failed_login_count   integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  ADD COLUMN locked_until         timestamptz,
  ADD COLUMN last_login_at        timestamptz;

-- البحث عن الشركة برمزها قبل معرفة سياقها (تسجيل الدخول).
-- لم نستعمل دالة SECURITY DEFINER: FORCE RLS يسري على مالك الدالة أيضاً فكانت ستعيد صفراً في الإنتاج.
-- بدلاً منها سياسة SELECT ثانية تكشف الصف الذي يطابق الرمز المضبوط في app.lookup_code فقط؛
-- من لا يعرف الرمز لا يستطيع قراءة شيء، وهذا ما تفعله الدالة لكن بلا امتياز مرتفع.
-- Looking up a company by code before its context is known (login).
-- We avoided a SECURITY DEFINER function: FORCE RLS also binds the function owner, so it would
-- return nothing in production. Instead a second SELECT policy exposes only the row whose code
-- equals the one set in app.lookup_code; knowing the code is required, as with a function, but
-- no elevated privilege is involved. Permissive policies are OR-ed with tenant_isolation.
CREATE POLICY company_code_lookup ON companies
  FOR SELECT TO inventory_app
  USING (
    code IS NOT NULL
    AND deleted_at IS NULL
    AND code = NULLIF(current_setting('app.lookup_code', true), '')
  );
