FROM node:20-slim
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/* \
  && git config --global user.name "Rulebook" \
  && git config --global user.email "rulebook@localhost"
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
# init:workspace is idempotent, so restarts keep the existing workspace (mount a volume at /app/workspace).
CMD ["sh", "-c", "npm run init:workspace && npm run start -- -p ${PORT:-3000}"]
