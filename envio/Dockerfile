FROM node:24-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends postgresql-client ca-certificates && \
    rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN npm install -g pnpm@9.15.1

WORKDIR /envio-indexer

COPY ./package.json ./package.json
RUN pnpm install --no-frozen-lockfile

COPY ./config.yaml ./config.yaml
COPY ./schema.graphql ./schema.graphql
COPY ./abis ./abis
COPY ./tsconfig.json ./tsconfig.json
COPY ./src ./src

# Codegen runs at container startup so TOKEN_ADDRESS / ACL_CONTRACT_ADDRESS
# can vary without rebuilding the image.
CMD ["sh", "-c", "pnpm envio codegen && pnpm envio start"]
