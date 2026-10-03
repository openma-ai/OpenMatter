FROM node:22-bookworm-slim

WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build:projects

ENV PROJECT_WORKER_LISTEN=0.0.0.0:8788
EXPOSE 8788
CMD ["node", "packages/project-worker/dist/index.js"]
