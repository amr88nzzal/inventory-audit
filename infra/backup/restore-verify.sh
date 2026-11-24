#!/usr/bin/env bash
# استعادة تجريبية: يفك آخر نسخة (أو الملف المعطى) إلى قاعدة مؤقتة ويتحقق من سلامتها ثم يحذفها.
# نجاحه هو الدليل الوحيد على أن النسخة صالحة؛ شغّله دورياً (مجدول أسبوعياً في الدليل التشغيلي).
#
# الاستعمال: restore-verify.sh [مسار db-*.dump.enc]
# المتغيرات: PG* (حساب بصلاحية CREATEDB)، BACKUP_DIR، BACKUP_PASSPHRASE_FILE،
#            EXPECT_MIN_MIGRATION (اختياري: أقدم ترحيل يجب أن يكون مطبَّقاً)
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
: "${BACKUP_PASSPHRASE_FILE:?حدّد BACKUP_PASSPHRASE_FILE}"
src="${1:-$(ls -1 "$BACKUP_DIR"/db-*.dump.enc 2>/dev/null | sort -r | head -n 1)}"
[ -n "$src" ] && [ -f "$src" ] || { echo "FAIL: لا نسخة للاستعادة" >&2; exit 2; }

ts="$(basename "$src" | sed -E 's/^db-(.*)\.dump\.enc$/\1/')"
manifest="$BACKUP_DIR/manifest-$ts.sha256"
if [ -f "$manifest" ]; then
  ( cd "$(dirname "$src")" && sha256sum --check --quiet "$(basename "$manifest")" ) \
    || { echo "FAIL: بصمة النسخة لا تطابق (تلف أو عبث)" >&2; exit 3; }
  echo "بصمة SHA-256 سليمة"
else
  echo "تنبيه: لا ملف بصمة لهذه النسخة" >&2
fi

scratch="restore_verify_$(date -u +%s)_$$"
work="$(mktemp -d)"
cleanup() { psql -d postgres -qAtc "drop database if exists \"$scratch\"" >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT

openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$BACKUP_PASSPHRASE_FILE" <"$src" >"$work/db.dump" \
  || { echo "FAIL: فك التشفير (عبارة خاطئة أو ملف تالف)" >&2; exit 4; }

psql -d postgres -qAtc "create database \"$scratch\"" >/dev/null
# الأدوار (inventory_app وinventory_login) قد لا توجد في قاعدة التحقق؛ --no-owner/--no-privileges في النسخ يكفي لاستعادتها
pg_restore --dbname="$scratch" --no-owner --no-privileges --exit-on-error "$work/db.dump" \
  || { echo "FAIL: pg_restore" >&2; exit 5; }

q() { psql -d "$scratch" -qAtc "$1"; }
tables="$(q "select count(*) from information_schema.tables where table_schema = 'public'")"
migs="$(q "select count(*) from schema_migrations")"
last="$(q "select name from schema_migrations order by name desc limit 1")"
companies="$(q "select count(*) from companies")"
echo "الجداول: $tables · التهجيرات: $migs (آخرها $last)"
# النسخة بحساب المالك فتتجاوز RLS؛ الفحص هنا على مستوى الخادم لا الشركة.
# The dump is taken as the owner so it bypasses RLS; this check is server-wide, not per company.
echo "الشركات: $companies"
[ "$tables" -ge 5 ] || { echo "FAIL: عدد الجداول غير معقول" >&2; exit 6; }
[ "$companies" -ge 1 ] || { echo "FAIL: لا شركات في النسخة" >&2; exit 7; }
# سلامة مرجعية بسيطة: لا مستخدمين ولا أدوار بلا شركة
orphans="$(q "select (select count(*) from users u where not exists (select 1 from companies c where c.id = u.company_id)) + (select count(*) from roles r where not exists (select 1 from companies c where c.id = r.company_id))")"
[ "$orphans" = "0" ] || { echo "FAIL: سجلات بلا شركة ($orphans)" >&2; exit 8; }
if [ -n "${EXPECT_MIN_MIGRATION:-}" ]; then
  q "select 1 from schema_migrations where name = '$EXPECT_MIN_MIGRATION'" | grep -q 1 \
    || { echo "FAIL: التهجير $EXPECT_MIN_MIGRATION غير موجود في النسخة" >&2; exit 9; }
fi
echo "PASS: الاستعادة التجريبية ناجحة ($ts)"
