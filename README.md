# Inventory Audit — تطبيق الجرد

نظام ويب + موبايل لتنفيذ الجرد الميداني للمخزون: الأدمن يسند مهام الجرد، والموظفون يمسحون الباركود (حتى دون اتصال)، ثم تُولَّد تقارير الفروقات.

Web + mobile inventory auditing: admins assign audit tasks, employees scan barcodes (offline-capable), and variance reports are generated.

## الحالة

المرحلة 0 (الأساس) مدمجة. المرحلة 1أ (قاعدة البيانات والعزل بين الشركات) والمرحلة 1ب-1 (الدخول برمز الشركة) قيد المراجعة. هذا المستودع إعادة بناء كاملة بمعايير مشروع HRMS؛ المستودع القديم `Inventory_scaner` مصدر أفكار فقط.

## الوثائق

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): العزل بين الشركات والتهجيرات والاختبارات.
- [`docs/PLAN.md`](docs/PLAN.md): الخطة الحيّة (DoD، المراحل، المخاطر، سجل التغييرات).
- [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md): قواعد الكود وGit وسجل القرارات.
- [`docs/RUNBOOK.md`](docs/RUNBOOK.md): النشر والتشغيل وقائمة قبول المستخدم (UAT).
- [`docs/guide/`](docs/guide/README.md): دليل المستخدم (مقال لكل ميزة).
- [`docs/LEGACY-FEATURES.md`](docs/LEGACY-FEATURES.md): الميزات المستخلصة من القديم والدروس.

## التشغيل المحلي

```bash
pnpm install
cp .env.example .env            # ثم عدّل كلمة المرور
docker compose up -d postgres   # قاعدة بيانات للتطوير
pnpm --filter @inventory/api dev

pnpm test                       # وحدة
TEST_DATABASE_URL=postgres://postgres:...@127.0.0.1:5432/postgres pnpm test:integration
```
