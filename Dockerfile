FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js discovery.js announce.js ./
COPY public ./public
# La app Android ya compilada, para el botón "Descargar app Android"
COPY apk ./apk
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
