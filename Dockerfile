FROM mcr.microsoft.com/playwright:v1.55.0-noble

WORKDIR /app

COPY package*.json ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --omit=dev

COPY server.js .
COPY public ./public

RUN mkdir -p /app/cache /app/uploads

ENV NODE_ENV=production
ENV PORT=10000

EXPOSE 10000

CMD ["npm", "start"]