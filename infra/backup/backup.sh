#!/usr/bin/env bash
# نسخة احتياطية منطقية مشفّرة: قاعدة البيانات (pg_dump -Fc) + ملفات التخزين، مع بصمة SHA-256 وتدوير.
#
# المتغيرات (libpq القياسية + التالية):
#   PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE     اتصال القاعدة (حساب المالك)
#   BACKUP_DIR              مجلد النسخ (الافتراضي /backups)
#   BACKUP_PASSPHRASE_FILE  ملف عبارة التشفير (مطلوب؛ احفظ نسخة منه خارج السيرفر!)
#   FILES_DIR               مجلد ملفات التخزين لإدراجه (اختياري؛ الافتراضي /data/files إن وُجد)
#   KEEP_DAILY=7 KEEP_WEEKLY=4 KEEP_MONTHLY=6   سياسة الاحتفاظ
#   INCLUDE_FILES=1         0 = قاعدة البيانات فقط بلا ملفات التخزين
#   COMPRESS_LEVEL=6       مستوى ضغط pg_dump (1–9)
#   --prune                  تدوير النسخ القديمة فقط (بلا نسخ جديد)
#   BACKUP_REMOTE           وجهة rclone خارج السيرفر (مثل b2:inventory-backups)؛ اختياري لكن موصى به
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
FILES_DIR="${FILES_DIR:-/data/files}"
KEEP_DAILY="${KEEP_DAILY:-7}"
KEEP_WEEKLY="${KEEP_WEEKLY:-4}"
KEEP_MONTHLY="${KEEP_MONTHLY:-6}"
INCLUDE_FILES="${INCLUDE_FILES:-1}"
COMPRESS_LEVEL="${COMPRESS_LEVEL:-6}"
: "${BACKUP_PASSPHRASE_FILE:?حدّد BACKUP_PASSPHRASE_FILE}"
if [ -d "$BACKUP_PASSPHRASE_FILE" ]; then
  echo "عبارة التشفير مجلد وليست ملفاً: أنشأه Docker لأن الملف لم يكن موجوداً عند التشغيل. احذف المجلد على الخادم وأنشئ الملف ثم أعد تشغيل backup" >&2; exit 2
fi
[ -f "$BACKUP_PASSPHRASE_FILE" ] && [ -s "$BACKUP_PASSPHRASE_FILE" ] || { echo "ملف عبارة التشفير فارغ أو مفقود" >&2; exit 2; }

# ───── التدوير: يومي/أسبوعي (الأحد)/شهري (أول الشهر) ─────
prune() {
  local keep_set
  keep_set="$(mktemp)"
  ls -1 "$BACKUP_DIR"/db-*.dump.enc 2>/dev/null | sort -r | head -n "$KEEP_DAILY" >>"$keep_set" || true
  ls -1 "$BACKUP_DIR"/db-*.dump.enc 2>/dev/null | sort -r | while read -r f; do
    d="$(basename "$f" | sed -E 's/^db-([0-9]{8}).*/\1/')"
    [ "$(date -u -d "$d" +%u 2>/dev/null)" = "7" ] && echo "$f"
  done | head -n "$KEEP_WEEKLY" >>"$keep_set" || true
  ls -1 "$BACKUP_DIR"/db-*.dump.enc 2>/dev/null | sort -r | while read -r f; do
    d="$(basename "$f" | sed -E 's/^db-([0-9]{8}).*/\1/')"
    [ "${d:6:2}" = "01" ] && echo "$f"
  done | head -n "$KEEP_MONTHLY" >>"$keep_set" || true
  for f in "$BACKUP_DIR"/db-*.dump.enc; do
    [ -e "$f" ] || continue
    if ! grep -qxF "$f" "$keep_set"; then
      t="$(basename "$f" | sed -E 's/^db-(.*)\.dump\.enc$/\1/')"
      rm -f "$f" "$BACKUP_DIR/files-$t.tgz.enc" "$BACKUP_DIR/manifest-$t.sha256"
      echo "حُذفت نسخة قديمة: $t"
    fi
  done
  rm -f "$keep_set"
}
if [ "${1:-}" = "--prune" ]; then prune; exit 0; fi

ts="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
chmod 711 "$BACKUP_DIR"
work="$(mktemp -d "$BACKUP_DIR/.work.XXXXXX")"
trap 'rm -rf "$work"' EXIT

enc() { openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$BACKUP_PASSPHRASE_FILE"; }

echo "[$ts] dump قاعدة البيانات…"
pg_dump --format=custom --no-owner --no-privileges --compress="$COMPRESS_LEVEL" --file="$work/db.dump"
# التحقق أن الملف قابل للقراءة قبل التشفير (قائمة المحتويات)
pg_restore --list "$work/db.dump" >/dev/null

out_db="$BACKUP_DIR/db-$ts.dump.enc"
enc <"$work/db.dump" >"$out_db"
files=("$out_db")

if [ "$INCLUDE_FILES" = "1" ] && [ -d "$FILES_DIR" ] && [ -n "$(ls -A "$FILES_DIR" 2>/dev/null)" ]; then
  echo "[$ts] أرشفة الملفات…"
  tar -C "$FILES_DIR" -czf "$work/files.tgz" .
  out_files="$BACKUP_DIR/files-$ts.tgz.enc"
  enc <"$work/files.tgz" >"$out_files"
  files+=("$out_files")
fi

# بصمة النسخة (للتحقق عند الاستعادة وعند النقل)
( cd "$BACKUP_DIR" && sha256sum "${files[@]##*/}" >"manifest-$ts.sha256" )
chmod 644 "$BACKUP_DIR"/*"$ts"*

prune

if [ -n "${BACKUP_REMOTE:-}" ]; then
  echo "[$ts] رفع خارج السيرفر → $BACKUP_REMOTE"
  rclone copy "$BACKUP_DIR" "$BACKUP_REMOTE" --include "*$ts*" --quiet
else
  echo "تنبيه: BACKUP_REMOTE غير مضبوط؛ النسخ على السيرفر نفسه فقط (لا تكفي للكوارث)" >&2
fi
echo "[$ts] اكتمل: $(basename "$out_db")"
