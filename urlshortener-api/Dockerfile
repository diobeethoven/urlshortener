FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json .
COPY src ./src

RUN npm run build

FROM node:20-alpine AS runtime

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY package.json ./

RUN npm ci --production --ignore-scripts

EXPOSE 8080

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]