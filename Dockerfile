# BAROMETRU — server Node fără nicio dependență npm.
#
# Imaginea conține doar partea de afișare. Analiza rulează într-un GitHub
# Action, iar rezultatul e adus la pornire din release-ul `analiza`.
# Pentru a rula și analiza în container, pune ANALIZA=complet și dă-i
# SOLR_BASE / SOLR_USER / SOLR_PASS.
FROM node:20-slim
WORKDIR /app
COPY . .
RUN rm -rf runs && mkdir -p runs
ENV NODE_ENV=production
ENV PORT=7777
ENV ANALIZA=off
EXPOSE 7777
# Secretele vin de la gazdă, niciodată din imagine.
CMD ["npm", "start"]
