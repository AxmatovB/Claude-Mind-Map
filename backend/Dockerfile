FROM node:20-alpine

WORKDIR /app/backend
COPY backend/package.json ./
RUN npm install --omit=dev

COPY backend/ ./
COPY frontend/ ../frontend/

ENV PORT=4545
EXPOSE 4545

CMD ["node", "server.js"]
