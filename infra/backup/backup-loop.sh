#!/usr/bin/env bash
# مشغّل النسخ الاحتياطي المجدول: نسخة يومية عند BACKUP_HOUR_UTC، واستعادة تحقق كل أحد، وملفات حالة JSON.
# Scheduled backup runner: a daily backup at BACKUP_HOUR_UTC, a restore-verify every Sunday, and JSON status files.
#
# الحالة: $BACKUP_DIR/status-backup.json و status-restore.json بصيغة {result, at, message}
# (يفحصها RUNBOOK: نسخة أقدم من 26 ساعة = تنبيه). Status files are what RUNBOOK checks (older than 26h = alert).
set -uo pipefail
BACKUP_DIR="${BACKUP_DIR:-/backups}"
HOUR="$((10#${BACKUP_HOUR_UTC:-02}))"
mkdir -p "$BACKUP_DIR"

status() { # status <file> <ok|fail> <message>
  jq -n --arg r "$2" --arg at "$(date -u +%FT%TZ)" --arg m "$3" '{result:$r, at:$at, message:$m}' >"$BACKUP_DIR/$1.new" \
    && mv "$BACKUP_DIR/$1.new" "$BACKUP_DIR/$1" && chmod 644 "$BACKUP_DIR/$1"
}

run_backup() {
  if out="$(/opt/backup/backup.sh 2>&1)"; then status status-backup.json ok "$(echo "$out" | tail -n 1)"
  else status status-backup.json fail "$(echo "$out" | tail -n 3 | tr '\n' ' ')"; fi
  echo "$out"
}
run_verify() {
  if out="$(/opt/backup/restore-verify.sh 2>&1)"; then status status-restore.json ok "$(echo "$out" | tail -n 1)"
  else status status-restore.json fail "$(echo "$out" | tail -n 3 | tr '\n' ' ')"; fi
  echo "$out"
}

echo "backup loop: daily at ${HOUR}:00 UTC, verify on Sundays"
last_day=""
while true; do
  now_h="$((10#$(date -u +%H)))"; today="$(date -u +%F)"
  if [ "$now_h" -ge "$HOUR" ] && [ "$last_day" != "$today" ]; then
    run_backup
    # الأحد = 7. Sunday = 7.
    [ "$(date -u +%u)" = "7" ] && run_verify
    last_day="$today"
  fi
  sleep 60
done
