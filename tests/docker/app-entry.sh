#!/bin/sh
# One Studio desktop, or one headless Studio server, in a container
# (tests/docker/README.md).
#
# As root: name the interface on the stack's 100.64/10 network `tailscale0`, so
# Studio's tailnet listener binds there as on a real tailnet, and write the node
# list the `tailscale` stand-in answers from. Then, as `tester`: a virtual
# display, the app on its own profile under /data, and the two listeners that
# bind loopback or the tailnet address only (DevTools, Studio's tailnet
# listener) published on fixed container ports for Docker to map.
set -eu

if [ "$(id -u)" = 0 ]; then
  if [ -n "${STUDIO_TAILNET_NODES:-}" ]; then
    dev=$(ip -o -4 addr show | awk '$4 ~ /^100\./ { print $2; exit }')
    address=$(ip -o -4 addr show dev "$dev" | awk '{ split($4, a, "/"); print a[1]; exit }')
    gateway=$(ip route show default | awk '{ print $3; exit }')
    ip link set "$dev" down
    ip link set "$dev" name tailscale0
    ip link set tailscale0 up
    [ -n "$gateway" ] && ip route replace default via "$gateway" dev tailscale0
    node -e '
      const [self, list] = process.argv.slice(1)
      const nodes = Object.fromEntries(list.split(",").map((pair) => pair.split("=")))
      require("fs").writeFileSync("/tmp/studio-tailnet.json", JSON.stringify({ self, nodes }))
    ' "$STUDIO_TAILNET_SELF" "$STUDIO_TAILNET_NODES"
    chmod 644 /tmp/studio-tailnet.json
    echo "$address" > /tmp/studio-tailnet-address
  fi
  exec setpriv --reuid=tester --regid=tester --init-groups --inh-caps=-all \
    env HOME=/home/tester USER=tester LOGNAME=tester "$0" "$@"
fi

export DISPLAY=:99 SHELL=/bin/bash LANG=C.UTF-8
export SPRINTENGINE_USER_DATA_DIR=/data/profile
profile=$SPRINTENGINE_USER_DATA_DIR
mkdir -p "$profile" /data/projects

# Profile switches, written once, as the Settings switches write them.
if [ -n "${STUDIO_TAILNET_NODES:-}" ] && [ ! -e "$profile/tailnet-remote-settings.json" ]; then
  printf '{\n  "enabled": true,\n  "port": 8471,\n  "notifications": false,\n  "https": false\n}\n' \
    > "$profile/tailnet-remote-settings.json"
fi
if [ "${STUDIO_SSH_MACHINES:-}" = on ] && [ ! -e "$profile/ssh-machines-preview.json" ]; then
  printf '{\n  "enabled": true\n}\n' > "$profile/ssh-machines-preview.json"
fi

# A key of this desktop's own for the stack's SSH machine (the harness installs
# the public half there), and a Host entry for it. known_hosts is left empty,
# so the first connection asks to trust the machine, as it would for a person.
if [ ! -e "$HOME/.ssh/id_ed25519" ]; then
  mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
  ssh-keygen -q -t ed25519 -N '' -C tester@example.com -f "$HOME/.ssh/id_ed25519"
fi

# A project to open: a repository with one commit.
if [ ! -d /data/projects/demo/.git ]; then
  mkdir -p /data/projects/demo && cd /data/projects/demo
  git init -q -b main
  git config user.name Tester && git config user.email tester@example.com
  printf '# Demo\n\nA project for the test harness.\n' > README.md
  git add . && git commit -qm 'Initial files'
  cd /
fi
git config --global user.name Tester
git config --global user.email tester@example.com

# The headless server alone, serving the web client (the `web` topology). Its
# listener takes the loopback port only and checks the origin a browser names,
# so the published port is the same number on the host and here, and socat
# carries the container's own address to it.
if [ "${STUDIO_ROLE:-desktop}" = web ]; then
  port=$STUDIO_WEB_PORT
  socat "TCP-LISTEN:$port,bind=$(hostname -i | awk '{ print $1 }'),fork,reuseaddr" "TCP:127.0.0.1:$port" &
  cd /data/projects
  exec node /app/out/server/server.cjs serve --data-dir /data/server --web --web-port "$port"
fi

Xvfb :99 -screen 0 "${STUDIO_SCREEN:-1440x900x24}" -nolisten tcp >/tmp/xvfb.log 2>&1 &
i=0
until [ -e /tmp/.X11-unix/X99 ] || [ $i -ge 100 ]; do i=$((i + 1)); sleep 0.1; done

# DevTools: Electron listens on 127.0.0.1:9223; the published port is 9222.
socat TCP-LISTEN:9222,fork,reuseaddr TCP:127.0.0.1:9223 &
# The main process's inspector (when started with --inspect=127.0.0.1:9229): 9230.
socat TCP-LISTEN:9230,fork,reuseaddr TCP:127.0.0.1:9229 &
# Studio's tailnet listener (the Studio protocol endpoint phones and paired
# desktops use) binds the tailnet address only; the published port is 18471.
if [ -e /tmp/studio-tailnet-address ]; then
  socat TCP-LISTEN:18471,fork,reuseaddr "TCP:$(cat /tmp/studio-tailnet-address):8471" &
fi

exec /app/node_modules/electron/dist/electron /app \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --password-store=basic \
  --remote-debugging-port=9223 \
  "$@"
