# SprintEngine Studio built from source for Linux, the base of the test
# harness's desktop image (harness.Dockerfile adds the harness's own files).
# tests/docker/studio-docker.mjs builds it from the checkout's files; see
# tests/docker/README.md.
FROM node:22-bookworm

# Electron's runtime libraries, a virtual display, socat to publish listeners
# that bind loopback only, git for projects and worktrees, ssh for SSH
# machines, iproute2 to name the tailnet stand-in's interface.
RUN apt-get -o Acquire::Retries=3 update \
 && apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
      xvfb xauth socat git openssh-client iproute2 procps ca-certificates fonts-liberation fonts-noto-color-emoji \
      libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 libxtst6 libatk-bridge2.0-0 libdrm2 libxkbcommon0 \
      libxshmfence1 libxrandr2 libxcomposite1 libxdamage1 libcups2 libsecret-1-0 \
 && rm -rf /var/lib/apt/lists/*

# The app, its agents and terminals run as this user, never as root.
RUN useradd -m -s /bin/bash tester \
 && mkdir -p /app /data && chown tester:tester /app /data
USER tester
WORKDIR /app

# Dependencies first, so a source change does not reinstall them.
COPY --chown=tester:tester package.json package-lock.json ./
COPY --chown=tester:tester scripts/fix-node-pty-permissions.js scripts/
RUN npm ci --no-audit --no-fund

COPY --chown=tester:tester . .
ARG STUDIO_COMMIT=unknown
RUN npx electron-vite build \
 && npm run build:server \
 && npm run build:server:wsl \
 && npm run build:web \
 && echo "$STUDIO_COMMIT" > /app/out/harness-commit
