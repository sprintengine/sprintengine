# A light stand-in for Studio's container image (resources/container/
# agent.Dockerfile) for the container suites: the same user, home (and its
# modes) and idle command, and git, with no agent CLIs, so CI builds it in seconds. The chat
# the suites drive runs on the built-in fake provider.
FROM debian:bookworm-slim
RUN apt-get -o Acquire::Retries=3 update \
 && apt-get -o Acquire::Retries=3 install -y --no-install-recommends ca-certificates git procps \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m -u 1000 -s /bin/sh node
USER node
WORKDIR /home/node
RUN mkdir -p /home/node/work && chmod 770 /home/node /home/node/work
CMD ["sleep", "infinity"]
