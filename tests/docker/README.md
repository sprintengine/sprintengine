# Studio in Docker, for test agents

Independent instances of SprintEngine Studio, each in its own container with its own data, for agents
that test the app by driving its window over the Chrome DevTools Protocol (CDP), several at a time.
Containers also stand in for the machines Studio reaches: an SSH machine, and a second desktop on a
tailnet to pair with.

Nothing here is used by the app or its test suites; it is a tool for hands-on testing.

## Commands

From the checkout, with Docker running and `npm ci` done (the smoke check uses its `playwright-core`):

```sh
node tests/docker/studio-docker.mjs build            # build the images from this checkout
node tests/docker/studio-docker.mjs up single         # start a stack; prints its URLs
node tests/docker/studio-docker.mjs smoke single-1    # check it end to end
node tests/docker/studio-docker.mjs ls                # the running stacks, as JSON lines
node tests/docker/studio-docker.mjs down single-1     # remove it: containers, data and network
node tests/docker/studio-docker.mjs down --all        # remove every stack
```

`up` builds the images first if they are missing. `build` again after changing the source: it
packs the checkout's tracked files and new files that are not ignored (not `mobile/`), so it tests
the working tree, committed or not. The first build takes about six minutes and makes a 5.4 GB
image; a build with only the harness's own files changed takes seconds.

`up <topology> --name <stack>` names the stack; without a name it is `<topology>-<n>`, the first one
free, so several agents can run `up` at once. `--json` prints the stack as JSON instead of text.
A failed `up` removes what it started. Every container and network carries the label
`studio-harness.stack=<stack>`, which is how `down` finds them; nothing else is touched.

## Topologies

| Topology | What runs |
|---|---|
| `single` | One desktop. |
| `ssh` | A desktop and an SSH machine, `build-box`, built on the SSH suites' sshd fixture (`src/main/environments/ssh/__fixtures__/sshd.Dockerfile`). |
| `paired` | Two desktops, `desk-a` and `desk-b`, on a stand-in tailnet, ready to pair in Settings ▸ Remote. |
| `web` | The headless server alone (`out/server/server.cjs serve --web`), serving the web client. |

For each desktop `up` prints:

- **CDP**: `http://127.0.0.1:<port>`, for `chromium.connectOverCDP`. The primary window is the page
  whose URL has `windowId=primary`.
- **server**: Studio's tailnet listener, the Studio protocol endpoint phones and paired desktops use
  (`/tailnet/v1/health` answers without a token). It is on in every topology.
- **main inspector**: the Electron main process's Node inspector, for stubbing what the window
  cannot reach (a native dialog, a notification).
- a shell: `docker exec -it -u tester <container> bash`.

Every port is published on 127.0.0.1 only.

### Driving a desktop

```js
const { chromium } = require('playwright-core')
const browser = await chromium.connectOverCDP('http://127.0.0.1:<cdp port>')
const page = browser.contexts()[0].pages().find((each) => each.url().includes('windowId=primary'))
```

Close with `browser.close()`, which disconnects and leaves the app running.

Each desktop has a repository with one commit at `/data/projects/demo`, and every Open Folder
answers that folder without a dialog (the app's own `SPRINTENGINE_TEST_OPEN_DIR` hook, which only
an unpackaged build reads). To answer another folder:

```sh
node tests/docker/studio-docker.mjs open-dir <stack> desk-a /data/projects/other
```

The display is 1440×900 (`STUDIO_SCREEN` in the container's environment changes it). Each desktop
may use 1.5 GB and 2 CPUs (`STUDIO_DOCKER_MEMORY`, `STUDIO_DOCKER_CPUS` when running `up`).

### Chats without an account

No container gets any credential. Chats run on a stand-in agent CLI, `tests/docker/bin/opencode`,
which Studio finds on the PATH as OpenCode and drives over the Agent Client Protocol as it drives
the real one. New chat offers it as the engine. It answers:

| Message | Reply |
|---|---|
| anything | `Stand-in agent (no real model): you said "…"`, streamed in pieces |
| `/slow` | a reply streamed over about 20 seconds, to try Stop |
| `/tool` | a tool call, then a reply |
| `/permission` | a permission request, then which option was chosen |
| `/fail` | the turn fails |

To test with a real agent instead, opt in when starting the stack: `STUDIO_DOCKER_ANTHROPIC_API_KEY`
or `STUDIO_DOCKER_OPENAI_API_KEY` in the environment of `up` is passed to its desktops as
`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, and the CLI is installed by hand
(`docker exec -u root <container> npm install -g <package>`). Use a key made for testing; the
harness never sets one itself.

### SSH machine (`ssh`)

`build-box` is on the stack's network. In the desktop, Settings ▸ Agents ▸ SSH machines is already on
(`ssh-machines-preview.json` in the profile), so Settings ▸ Machines takes `dev@build-box`. The
desktop's own key is admitted there, and `known_hosts` is empty, so the first connection asks to
trust the machine, as it would for a person. The password `devpass` works too. Studio installs its
server on the machine, which fetches the pinned Node runtime from the internet, so the VM needs
network access. `/home/dev/proj` is a repository with one commit, and the stand-in agent is
installed there, so a chat on the machine answers like a local one.

### Paired desktops (`paired`)

Studio's tailnet features need two things a container has no real way to get: an interface that is
Tailscale's, and the `tailscale` CLI. The stack's network is a /24 inside `100.64.0.0/10` (Tailscale's
range), each desktop's interface on it is named `tailscale0` (the container has `NET_ADMIN` for the
rename, then drops to the `tester` user), and `tests/docker/bin/tailscale` answers `status --json`,
`whois --json`, `ip` and `version` from the stack's node list, under the MagicDNS suffix
`example.ts.net`. Studio's own code does the rest: its listener binds `tailscale0`, discovery
probes the peers, and pairing, the code check and chats on the other desktop run as on a real
tailnet. `tailscale serve` (HTTPS) is refused.

To pair: in `desk-a`, Settings ▸ Remote lists `desk-b` with **Pair**; ask to pair, read the code it
shows, and type it into the request on `desk-b` (its toast, or Settings ▸ Remote). Then New chat on
either desktop offers the other as a machine.

### Web client (`web`)

`up web` prints the web client's URL and a pairing link (it works once, within five minutes;
`pair <stack>` prints another). Drive it with any browser, for example `chromium.launch()` from
`playwright-core` after `npx playwright-core install chromium`. The listener checks the origin a
browser names, so its port is the same inside the container and on this machine.

## What it cannot do

- **WSL.** Studio offers WSL distributions only on Windows (`src/main/hosts/host-registry.ts` lists
  none elsewhere), so a Linux container cannot show one in the app. The WSL server tree is the one
  `ssh` installs on `build-box`; the cross-client gate (`npm run test:cross-client`) drives a WSL
  distribution with `sh` standing in for `wsl.exe`.
- **The phone.** No phone app runs here. Its protocol is the one the **server** port serves; the
  cross-client gate drives the phone's own protocol client.
- **A real tailnet.** The stand-in covers what Studio asks the CLI. Tailscale Serve, MagicDNS
  resolution and real node keys are not simulated.
- **macOS and Windows behaviour.** The app runs as its Linux build (arm64 on an Apple-silicon Mac).
- `docker stats` may show 0 B for these containers; the VM's cgroup files have the figures
  (`colima ssh -- cat /sys/fs/cgroup/docker/<id>/memory.current`).

## Capacity

Measured on a Colima VM with 6 CPUs and 8 GB: a desktop takes about 250 MB idle and 250–350 MB after
a chat (a first SSH install peaks near 900 MB, mostly page cache). Nine desktops and an SSH machine
ran at once in 3 GB with the VM's load under 0.3, and four stacks started and passed `smoke` in
parallel. Memory allows about fifteen desktops; with six CPUs, keep the number driven at the same
moment to about eight.

## Files

| File | What it is |
|---|---|
| `studio-docker.mjs` | `build`, `up`, `ls`, `smoke`, `pair`, `open-dir`, `down` |
| `smoke.mjs` | the smoke check |
| `app.Dockerfile` | the app built from source for Linux (Electron, the server, the WSL/SSH server tree, the web client) |
| `harness.Dockerfile` | the desktop image: the app plus the entry script and stand-in CLIs |
| `ssh-machine.Dockerfile` | `build-box`: the sshd fixture plus git, Node, the stand-in agent and a project |
| `app-entry.sh` | the container's entry: tailnet interface, profile switches, display, listeners, the app |
| `bin/opencode` | the stand-in agent CLI |
| `bin/tailscale` | the stand-in `tailscale` CLI |
