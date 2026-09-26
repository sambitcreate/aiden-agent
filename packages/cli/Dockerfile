FROM node:22-bookworm AS build
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 PI_TELEMETRY=0 PI_OFFLINE=1
WORKDIR /build
RUN apt-get update -qq && apt-get install -y --no-install-recommends libssl-dev ca-certificates openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY packages/cli/package.json packages/cli/package-lock.json ./packages/cli/
RUN npm ci --prefix packages/cli
COPY main ./main
COPY renderer ./renderer
COPY resources ./resources
COPY native ./native
COPY scripts ./scripts
COPY packages/cli ./packages/cli
COPY THIRD_PARTY_NOTICES.md ./
RUN npm run build --prefix packages/cli && npm run type-check --prefix packages/cli

RUN node scripts/build-subagent-file-mutator.mjs --test && node --test scripts/subagent-file-mutator.test.mjs && node scripts/build-subagent-shell-runner.mjs --test && node_modules/.bin/tsx --test main/services/subagents/subagent-shell-runner-io.test.ts

RUN npm test --prefix packages/cli

FROM node:22-bookworm-slim
RUN apt-get update -qq && apt-get install -y --no-install-recommends git openssl ca-certificates libssl3 avahi-utils bzip2 && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /build/packages/cli /opt/aiden
ENV AIDEN_CODING_AGENT_DIR=/home/node/.aiden/agent PI_TELEMETRY=0
USER node
WORKDIR /workspace
EXPOSE 49320
ENTRYPOINT ["node", "/opt/aiden/dist/app/cli.js"]
CMD ["serve"]
