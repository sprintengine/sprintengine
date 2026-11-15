# The image a chat's container runs when the person has not named one: Node 22
# (Studio's server brings its own pinned Node; this one is for the project's
# tooling), git, and the agent CLIs a chat can start. Built on the machine that
# runs the container, on first use, and tagged by this file's digest, so an app
# update that changes it builds a new one and an unchanged one is reused.
#
# Nothing secret is ever built into it: an agent signs in inside the container
# it runs in, and the repository is copied in after the container starts.
FROM node:22-bookworm-slim

ARG CLAUDE_CODE_VERSION=2.1.325
ARG CODEX_VERSION=0.169.0

RUN apt-get -o Acquire::Retries=3 update \
 && apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
      ca-certificates git openssh-client procps less ripgrep curl \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force

# The CLIs are pinned by this file: they do not update themselves inside a
# container that is kept between chats.
ENV DISABLE_AUTOUPDATER=1

# Agents run as the image's own unprivileged user (Claude Code refuses to skip
# its permission prompts as root). Its first-run questions are answered once
# here, so a chat does not stop on them; the file holds no credential.
USER node
WORKDIR /home/node
RUN mkdir -p /home/node/work /home/node/.claude \
 && printf '{"hasCompletedOnboarding":true,"bypassPermissionsModeAccepted":true}\n' > /home/node/.claude.json

# The container idles; Studio's server is started in it over `docker exec`.
CMD ["sleep", "infinity"]
