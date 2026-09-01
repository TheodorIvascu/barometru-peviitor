# BAROMETRU — a small Node server. Solr lives at peviitor.ro, so there is
# nothing heavy to host: no database, no search engine, no build step.
FROM node:20-slim

WORKDIR /app

# Only the manifests first, so a code change does not reinstall dependencies.
COPY package.json package-lock.json* ./

# --omit=optional leaves out Playwright (114MB of Chromium) and the local
# embedding model. Neither is used by the server; both stay available locally.
RUN npm install --omit=dev --omit=optional --no-audit --no-fund

COPY . .

# The caches are NOT shipped: they are derived data, 300MB of it, and the app
# rebuilds them from production on startup in about 30 seconds.
RUN rm -rf cache && mkdir -p cache

ENV NODE_ENV=production
ENV PORT=7777
EXPOSE 7777

# Secrets are supplied by the host as environment variables, never baked in:
#   SOLR_BASE, ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN,
#   GEMINI_API_KEY, GROQ_API_KEY, BAROMETRU_PASSWORD
CMD ["node", "server/index.js"]
