FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates sqlite3 tini \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY README.md LICENSE sources.yaml ./
COPY scripts ./scripts

RUN npm run build && npm link

ENV ONI_HOME=/oni
VOLUME ["/oni"]

ENTRYPOINT ["tini", "--", "oni"]
CMD ["--help"]
