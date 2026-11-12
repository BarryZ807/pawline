FROM node:24.14.0-bookworm-slim
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates fonts-dejavu-core fontconfig && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build
RUN chmod -R u=rwX,go=rX /app/public && mkdir -p /media && chown node:node /media
USER node
EXPOSE 3000
CMD ["npm","start"]
