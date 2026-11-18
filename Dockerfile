FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
ENV PORT=8787 DATA_DIR=/app/data/rooms
EXPOSE 8787
RUN mkdir -p /app/data/rooms && chown -R node:node /app/data
USER node
CMD ["node", "src/index.js"]
