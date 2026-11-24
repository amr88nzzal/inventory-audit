# حاوية النسخ الاحتياطي المجدولة: أدوات pg_dump/psql بنفس إصدار القاعدة + openssl + rclone
# Scheduled backup container: pg_dump/psql matching the database version, plus openssl and rclone
ARG POSTGRES_IMAGE=public.ecr.aws/docker/library/postgres:16
FROM ${POSTGRES_IMAGE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends rclone openssl ca-certificates tar jq \
 && rm -rf /var/lib/apt/lists/*
COPY infra/backup/backup.sh infra/backup/restore-verify.sh infra/backup/backup-loop.sh /opt/backup/
RUN chmod +x /opt/backup/*.sh
ENTRYPOINT ["/opt/backup/backup-loop.sh"]
