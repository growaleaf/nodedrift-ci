FROM node:18-slim
WORKDIR /app
COPY . .
RUN npm ci --production
CMD ["node", "server.js"]
