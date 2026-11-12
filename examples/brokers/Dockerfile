# The Node services (orders and notifier). Run ./pack.sh first: it puts the Ida packages from this repo in packs/.
FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY packs ./packs
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
