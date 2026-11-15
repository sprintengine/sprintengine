# The harness's SSH machine: the SSH suites' sshd fixture
# (src/main/environments/ssh/__fixtures__/sshd.Dockerfile, user `dev`,
# password `devpass`) plus git, a Node for the stand-in agent CLI, and a
# project with one commit at /home/dev/proj.
ARG SSHD_IMAGE
FROM ${SSHD_IMAGE}
RUN apt-get -o Acquire::Retries=3 update \
 && apt-get -o Acquire::Retries=3 install -y --no-install-recommends git nodejs ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
COPY bin/opencode /usr/local/bin/opencode
RUN chmod 755 /usr/local/bin/opencode \
 && su dev -c 'mkdir -p /home/dev/proj && cd /home/dev/proj && git init -q \
      && git config user.name Tester && git config user.email tester@example.com \
      && echo "A project on the SSH machine." > README.md && git add . && git commit -qm "Initial files"'
