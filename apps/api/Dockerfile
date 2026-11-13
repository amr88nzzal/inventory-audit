# البناء من جذر المستودع: docker build -f apps/api/Dockerfile .
# Build from the repo root: docker build -f apps/api/Dockerfile .
#
# الصور الأساسية عبر مرآة ECR لتجنب حدّ 429 في Docker Hub، وهي متعددة المعماريات (arm64 مدعوم).
# Base images come from the ECR mirror to avoid Docker Hub 429s; multi-arch, so arm64 works.
FROM public.ecr.aws/docker/library/node:22-slim AS builder
WORKDIR /app
RUN corepack enable

# نسخ ملفات الاعتماديات أولاً لتستفيد الطبقة من الكاش.
# Copy dependency manifests first so the layer caches.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

COPY apps/api apps/api
COPY packages/shared packages/shared
RUN pnpm --filter @inventory/api build

# مرحلة التشغيل: اعتماديات الإنتاج فقط ومستخدم غير جذر.
# Runtime stage: production dependencies only, non-root user.
FROM public.ecr.aws/docker/library/node:22-slim AS runner
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production
ENV PORT=3000

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --prod --filter @inventory/api...

COPY --from=builder /app/apps/api/dist apps/api/dist

USER node
EXPOSE 3000
WORKDIR /app/apps/api
CMD ["node", "dist/server.js"]
