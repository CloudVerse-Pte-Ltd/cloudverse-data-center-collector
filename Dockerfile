ARG NODE_BASE=node:22-alpine3.22@sha256:cd7807368cf24826297cbad5dca1a44972ccfd770647db52a8c7589eb4599ac8
FROM --platform=$BUILDPLATFORM ${NODE_BASE} AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts --no-audit --fund=false
COPY packages/gpu-finops/src ./packages/gpu-finops/src
RUN npm run build \
  && npm prune --omit=dev --ignore-scripts \
  && npm cache clean --force

FROM ${NODE_BASE}
RUN addgroup -S -g 65532 collector && adduser -S -D -H -u 65532 -G collector collector \
  && mkdir -p /app /var/lib/cloudverse/spool /var/run/cloudverse \
  && chown -R collector:collector /app /var/lib/cloudverse /var/run/cloudverse
WORKDIR /app
COPY --from=build /src/package.json /src/package-lock.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
USER 65532:65532
ENV NODE_ENV=production
ENTRYPOINT ["node", "dist/packages/gpu-finops/src/on-prem-collector/collector-entrypoint.js"]
