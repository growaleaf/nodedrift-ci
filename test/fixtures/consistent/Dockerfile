FROM node:20-slim
WORKDIR /app
COPY . .
RUN npm ci --production
CMD ["node", "server.js"]
