# دليل التشغيل — Runbook

يبدأ صغيراً ويكبر مع كل مرحلة (انظر DoD في `PLAN.md`).

## 1. النشر والتحديث

```bash
cd ~/inventory-audit && git pull
docker compose -f infra/docker-compose.yml --env-file .env up -d --build   # postgres + migrate + api + gateway
```

> نفس نمط HR. اختصار اختياري: ضع `COMPOSE_FILE=infra/docker-compose.yml` في `.env` فيكفي `docker compose up -d --build`. في بقية الأوامر أدناه `docker compose` تعني الأمر الكامل بـ `-f infra/docker-compose.yml --env-file .env`.

**كيف يعمل النشر:** `postgres` (داخل الشبكة فقط) ← `migrate` يعمل مرة بحساب المالك: يهجّر ثم `post-migrate` يضبط حساب `inventory_login` ← `api` ينتظر نجاح `migrate` ويتصل بـ `inventory_login` ← `gateway` (Nginx) على `127.0.0.1:${GATEWAY_PORT:-8080}` يستقبله نفق Cloudflare. الصور تُبنى على `linux/arm64`.

**لماذا حساب `inventory_login`:** ليس مالكاً ولا يتجاوز RLS ولا يملك صلاحية على أي جدول بذاته؛ يبدّل الدور داخل `withTenant`/`withPlatform` فقط. أي استعلام خارجهما يفشل بـ `permission denied`. يثبته اختبار تكامل وخطوة في CI.

- `.env` خارج المستودع؛ الأمثلة في `.env.example`. المتغيرات المطلوبة للإنتاج: `POSTGRES_USER` `POSTGRES_PASSWORD` `POSTGRES_DB` `APP_DB_PASSWORD` (16 حرفاً فأكثر) `JWT_SECRET` `ENCRYPTION_KEYS` `ENCRYPTION_KEY_ID`. الخادم يرفض الإقلاع بسرّ ضعيف أو ناقص.
- `JWT_SECRET`: `openssl rand -base64 48`. `APP_DB_PASSWORD`: `openssl rand -hex 24`.
- التهجيرات تُطبَّق في خدمة `migrate` قبل كل إقلاع (وليست عند إقلاع الـ API: `RUN_MIGRATIONS=false`). خذ نسخة احتياطية قبل أي تهجير مدمّر.
- فشل `migrate`: `docker compose logs migrate`؛ الـ API لن يقلع حتى ينجح.
- عند نشر ميزة تضيف صلاحية: امنحها للأدوار القائمة بعد النشر.

### أول مدير منصة (مدير المشروع)

1. ولّد مفتاح التشفير: `echo "k1:$(openssl rand -base64 32)"` وضعه في `.env` كـ `ENCRYPTION_KEYS` مع `ENCRYPTION_KEY_ID=k1`. **احفظ نسخة منه خارج الخادم وبعيداً عن النسخ الاحتياطية للقاعدة**؛ ضياعه يعني فقدان ربط TOTP (يُعالج بـ reset).
2. **الإنتاج (الخيار 2):** ضع `PLATFORM_ADMIN_USERNAME` و`PLATFORM_ADMIN_PASSWORD` (12 حرفاً فأكثر) ثم النشر. سيُنشأ الحساب عند الإقلاع.
3. سجّل الدخول من `/api/v1/platform/auth/login`: ستحصل على سر TOTP ورابط `otpauth://` مرة واحدة؛ أضفه لتطبيق المصادقة وأكمل `enroll` مع كلمة مرور جديدة.
4. **احذف `PLATFORM_ADMIN_PASSWORD` من `.env`** وأعد النشر.
5. **بديل (الخيار 1):** `docker compose exec -e PLATFORM_CLI_PASSWORD=... api node dist/cli.js create-platform-admin <name>`.
6. ضياع الجهاز أو كلمة المرور: `reset-platform-admin <name>` بكلمة مؤقتة جديدة، ثم ربط من جديد.

### الشركة التجريبية (للعرض والتجارب)

- الإنشاء أو إكمال الناقص: `docker compose exec api node dist/cli.js seed-demo` (آمن للإعادة؛ يُنفَّذ بعد كل نشر يضيف طبقة بيانات).
- **قبل كل عرض لمستخدم محتمل:** `docker compose exec api node dist/cli.js reset-demo` يعيدها نظيفة. لا يمسّ إلا الشركات المعلَّمة `is_demo`.
- الدخول: رمز `demo`، والحسابات وكلمتها في `docs/guide/articles/demo-company.md`. كلمتها معروفة عمداً فلا بيانات حقيقية فيها.

## 2. النسخ الاحتياطي والاستعادة

خدمة `backup` (profile اختياري) تنفّذ يومياً عند `BACKUP_HOUR_UTC`: `pg_dump -Fc` مشفّراً AES-256 (ملف العبارة `BACKUP_PASSPHRASE_FILE`) مع بصمة SHA-256، وتدوير 7 يومي/4 أسبوعي/6 شهري، ورفع اختياري خارج الخادم عبر `rclone` إلى `BACKUP_REMOTE`. كل أحد تُجري **استعادة تحقق** إلى قاعدة مؤقتة وتفحص: عدد الجداول، التهجيرات، وجود شركات، عدم وجود مستخدمين أو أدوار بلا شركة.

```bash
openssl rand -base64 48 | sudo tee /etc/inventory/backup.passphrase >/dev/null && sudo chmod 600 /etc/inventory/backup.passphrase
# ضع BACKUP_PASSPHRASE_FILE=/etc/inventory/backup.passphrase في .env (وانسخ العبارة خارج الخادم!)
docker compose --profile backup up -d --build backup
docker compose exec backup cat /backups/status-backup.json /backups/status-restore.json
docker compose exec backup /opt/backup/backup.sh            # نسخة فورية
docker compose exec backup /opt/backup/restore-verify.sh    # تحقق استعادة (رموز الخروج: 3 بصمة، 4 عبارة، 5–9 فحص)
```

- العبارة ومفتاح `ENCRYPTION_KEYS` **منفصلان عن النسخ**: ضياع أيهما يعني فقدان ما يخصه. احفظ نسخة خارج الخادم.
- راقب `status-backup.json`: أقدم من 26 ساعة = تنبيه. بلا `BACKUP_REMOTE` تبقى النسخ على الخادم نفسه ولا تكفي للكوارث.
- الاستعادة الفعلية إلى الإنتاج يدوية بقصد، بعد إيقاف `api` وبنسخة من الحالة الحالية.
- CI يشغّل النسخ والتحقق على الحزمة نفسها في كل PR.

## 3. المراقبة (مخطَّط)

`/api/v1/health` للفحص الخارجي؛ سجلات pino بصيغة JSON مع `requestId`.

## 4. الأمان

- البوابة Nginx على 127.0.0.1 خلف Cloudflare Tunnel؛ `trust proxy` وقراءة `CF-Connecting-IP`.
- لا أسرار في Git ولا في الصور.

## 5. قائمة قبول المستخدم (UAT)

تُوسَّع مع المراحل؛ كل بند يُؤشَّر عند التحقق منه على بيانات حقيقية.

- [ ] دخول بكل دور (مدير منصة، أدمن شركة، موظف جرد) ومطابقة الصلاحيات.
- [ ] إنشاء شركة جديدة وأدمنها الأول من صفحة مدير المنصة، وتغيير كلمة المرور المؤقتة.
- [ ] عزل الشركات: شركتان ولا يظهر سجل لإحداهما عند الأخرى.
- [ ] (المرحلة 2) استيراد الأصناف الحقيقية ومطابقتها.
- [ ] (المرحلة 3-4) مهمة جرد كاملة: إسناد ← مسح (حتى دون اتصال) ← مزامنة.
- [ ] (المرحلة 7) تقرير الفروقات يطابق حساباً يدوياً لعيّنة.
- [ ] نسخة احتياطية واستعادة ناجحة موثّقة بتاريخها.
- [ ] تدريب المستخدمين وتوقيع القبول (الاسم، التاريخ).
