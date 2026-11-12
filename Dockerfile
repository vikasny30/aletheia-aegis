FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src
COPY eval ./eval
RUN npm run build

ENTRYPOINT ["node", "dist/index.js"]
