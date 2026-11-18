# Build stage: TypeScript is a dev dependency, so compile here.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage: production dependencies, compiled code, and only the eval
# files the tools read (not the held-out model outputs). Runs as a non-root user.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY eval/cases.jsonl eval/redteam.jsonl eval/sample-corpus.jsonl ./eval/
USER node
ENTRYPOINT ["node", "dist/index.js"]
