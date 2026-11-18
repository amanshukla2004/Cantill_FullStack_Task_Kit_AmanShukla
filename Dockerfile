FROM node:24-slim

WORKDIR /app

# Install backend dependencies
COPY package*.json ./
RUN npm ci

# Install frontend dependencies
COPY client/package*.json ./client/
RUN npm --prefix client ci

# Copy application source & master kit data
COPY tsconfig.json ./
COPY src ./src
COPY client ./client
COPY master_data ./master_data
COPY contracts ./contracts
COPY pr_batches ./pr_batches

# Build TypeScript backend + React production bundle into dist/public
RUN npm run build

# Persistent SQLite storage directory
RUN mkdir -p /app/storage

ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PATH=/app/storage/procurement.db

EXPOSE 3000

CMD ["node", "dist/server/index.js"]
