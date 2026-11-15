# Chats in containers

Status: built 2026-11-15 (first cut). Owner decisions of 2026-11-15 are quoted
as rulings below. Where the code and this file disagree, fix one of them in the
same change.

## What it is

A chat can run in a Docker container of its own. In New chat, the strip under
the composer reads `Machine ▾ · Project ▾ · Worktree · Container ▾`. Container
is off by default ("No container"). Turned on ("Container"), Enter makes a
container on the machine the machine picker names, copies the project's
repository into it, and starts the chat there. The agent works inside the
container; its changes leave only as a branch, which Studio pushes from the
machine outside.

The Container chip wears a still isometric cube (`ContainerGlyph`,
`design-system/glyphs/container.svg`): three faces, the top shaded .45 and the
right .18, outline 1.4 in `currentColor` on the 16 grid. It never animates
(ruling). Its popover is the container's settings for the picked machine:

| Row              | What it says                                                                                                                                                                                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker           | Whether Docker is there, in words: "Docker 29.2.1 is running on this Mac (Colima).", "Colima is installed on this Mac, but it is stopped." with a Start Colima button, "Docker is installed on build-box, but it is not running.", "Docker was not found on build-box." No status dot (AGENTS.md). |
| Image            | Studio's default (below). A devcontainer or a project's Dockerfile is a later choice; `ContainerImageChoice` is the room left for it.                                                                                                                                                              |
| Repo             | Cloned in; changes leave as a pushed branch.                                                                                                                                                                                                                                                       |
| Network          | Full (ruling: full by default).                                                                                                                                                                                                                                                                    |
| After it settles | Kept, until the chat is deleted (ruling).                                                                                                                                                                                                                                                          |

Container is a separate choice from the machine and from Worktree (ruling). It
works on this computer and on any SSH machine Studio drives that has Docker.
WSL distributions and paired machines say "Containers on … are not built yet."
While Container is on, the Worktree chip is hidden: the container's copy is
already the chat's own checkout, on a branch of its own. A worktree inside a
container is later work.

## Architecture: a container is another machine

A container runs Studio's own server, as an SSH machine does, and is saved in
the same list of machines (`SavedSshEnvironment.container`,
`userData/ssh-environments.json`). Everything the SSH machines built works on
it unchanged: the probe, the streamed install of the pinned Node and the
server tree, the managed server's start and attach, the relay over an exec
channel, reconnects and liveness, window tickets on a loopback route, the
pane's traffic through the machine, the sign-in dialog, the sidebar, the chat
views. Only the exec channel differs:

| Machine                     | Exec channel the bootstrap script is written to                                        |
| --------------------------- | -------------------------------------------------------------------------------------- |
| SSH machine                 | `ssh … -- <machine> sh -s`                                                             |
| Container on this computer  | `/bin/sh -c 'docker start <c> && exec docker exec -i -u node -w /home/node <c> sh -s'` |
| Container on an SSH machine | `ssh … -- <machine> sh -c '<the same docker line>'`                                    |

`docker exec -i` gives the same stdin/stdout pair the SSH relay needs, so the
relay protocol, its marker handshake and its multiplexer are reused byte for
byte (`ssh-session.ts`, `relay-client.ts`). `SshEnvironment` was already
written against a `spawn()` that returns a stdin/stdout/stderr process, so the
container's `spawn` is the only new code on that path
(`ssh-environments.ts`, `machine()`).

Every other Docker action is also a short POSIX shell script run on the
container's host (`container/docker-host.ts`, `container/container-scripts.ts`):
this computer's `/bin/sh -c`, or the SSH machine's over the person's own ssh.
That is how one piece of code finds Docker, builds the image, starts, lists and
removes containers, and copies a repository in and a branch out, on whichever
machine Docker is on. Values from outside Studio (a folder path) are always
single-quoted; container and image names are Studio-minted and validated
before they are spelled.

### No new route kind

A container chat's workspace is recorded as `environment: { kind: 'ssh', id }`
and reached by the `ssh:<id>` route, where `id` is the container's saved
machine id. A separate `container:` route kind would have to be taught to about
sixty files that read the route kind (paths, spelling, the sidebar, the
pane, the gateway) for no difference in behaviour: every one of them treats the
container exactly as an SSH machine. The route kind `ssh` therefore names "a
machine this desktop saved and reaches over an exec channel it spawns". The
server inside says `hostKind: 'ssh'` in its welcome for the same reason. If the
distinction is ever needed on the wire, it is a new `hostKind`, behind a
capability (`docs/compatibility.md`).

## The repository: copied in, a branch out

Never a bind mount of the host's folder (ruling). On Enter:

1. Studio checks the folder on the host is a git repository, before anything
   is started.
2. `git bundle create - HEAD refs/heads/<the branch HEAD is on>` on the host
   (not every branch and tag there) is piped into `docker exec -i … git clone`
   inside the container, at `/home/node/work/<folder name>`. Uncommitted
   changes stay on the host.
3. Inside, `origin` is set back to the host's remote URL, as an address only:
   over http(s) everything before `@` is dropped (`https://TOKEN@host/…`,
   `https://user:token@host/…`); elsewhere a user name is kept and a password
   dropped. The copy's author is the host repository's `user.name` and
   `user.email`. These three travel on the clone's stdin ahead of the bundle,
   never in a command line. The chat works on a branch of its own,
   `studio/container-<id>`.

The branch leaves the same way, in reverse (`pushOutScript`): `docker exec … git
bundle create - refs/heads/<branch>` on the host, fetched into a ref of
Studio's own (`refs/sprintengine/containers/<id>`) in the host repository with
every object checked (`fetch.fsckObjects`), and pushed with the host's git: `git push origin <that ref>:refs/heads/<branch>`.
The person's branches and working tree are never written. The owner's git and
GitHub credentials never enter the container (the owner's proposal,
implemented): only the host pushes. Push is offered today as "Push branch" on
the container's row in Settings › Machines › Containers. A container chat's
panel draws no Create PR (as an SSH machine's chat draws none: its checkout is
not this computer's), so nothing there fails on a container's missing
credentials.

## Agent sign-in inside the container

Only the agent's own login goes inside. Two ways, both built:

- **A token, pasted once.** Settings › Machines › Containers takes a token
  from `claude setup-token` (run in a terminal on this computer). It is sealed
  with the app's keychain cipher (`container-agent-token.ts`) and handed to the
  Studio server of each container on this computer when it starts, as Claude
  Code's own `CLAUDE_CODE_OAUTH_TOKEN`. It goes by name: the host's `sh` and
  `docker exec -e CLAUDE_CODE_OAUTH_TOKEN` carry it in their environment
  (readable by the person's own user on the host, as any process's environment
  is), never in a command line, an image, or the container's saved config. A
  container's server is never started before the token has been read at app
  start, and setting or forgetting it restarts the servers of the containers
  on this computer, so none runs on a stale login. A container on an SSH
  machine is not given it (the value would have to cross ssh); it signs in the
  second way.
- **The machine's sign-in dialog**, as an SSH machine's chat does
  (`providers.signInStart`, `server/machine/machine-sign-in.ts`): the CLI's own
  login runs inside the container and its link and code show in Studio's
  dialog (`claude auth login` pastes a code back; `codex login --device-auth`
  shows a device code). The login stays inside the container
  (`~/.claude/.credentials.json`), kept with the chat and removed with it. A
  chat on another machine whose turn fails to authenticate offers this dialog
  from its failure card (`chatSignInProviderId`), rather than sending the
  person to a terminal on this computer.

The image answers Claude Code's first-run questions once
(`hasCompletedOnboarding` in `~/.claude.json`, no credential) and turns its
self-update off, so a kept container does not stop on them.

A stronger variant keeps even the token out: a placeholder inside and a proxy
on the host that adds the real `Authorization` header. Not built.

## Threat model

What a container is for: an agent that runs commands without asking reaches
nothing of the person's but the repository copy and its own login.

- **Kept out:** the host's folders (no mounts), the host's git and GitHub
  credentials (only the host pushes; a credential in the remote URL is
  stripped), the host's SSH agent and keys, every Linux capability
  (`--cap-drop ALL`) and any way to regain one (`no-new-privileges`).
- **Inside, by design:** the repository copy; the agent's own login (the token,
  or what its sign-in wrote), which the agent can read and use or send
  anywhere, since network access is full (owner ruling); whatever the agent
  downloads.
- **Coming out:** only the chat's branch, as a bundle the host fetches with
  object checks into a ref of Studio's and pushes. It is code an agent wrote:
  reviewing it is the pull request's job.
- **Known gap: the agent and Studio's server share a user.** Both run as the
  image's `node` user, and the server's data (its run directory, owner token
  and socket) is in that user's home. An agent can therefore drive its own
  container's server as its owner, stop it, or stand a process of its own in
  front of its socket. What that buys it is the protocol the desktop already
  treats as a remote machine's: the desktop holds such a server to exactly
  what it holds an SSH machine's server to. Closing the gap means running the
  server as a user of its own and the CLIs it starts as the agent's user (a
  follow-up).

## The image

`resources/container/agent.Dockerfile`, shipped with the app
(`extraResources` → `container/`): `node:22-bookworm-slim` pinned by digest, git, ripgrep,
procps, and pinned `@anthropic-ai/claude-code` and `@openai/codex`, running as
the image's unprivileged `node` user (Claude Code refuses to skip its
permission prompts as root). It is built on the container's host the first
time a container is made there (`docker build -` with the Dockerfile in the
script itself, no build context) and tagged `sprintengine-studio-agent:<first 12 hex of the
file's SHA-256>`, so an app update that changes the file builds a new image and
an unchanged one is reused. Studio's server brings its own pinned Node; the
image's Node is the project's. The first build takes a few minutes and the
image is about 1.6 GB, mostly the two CLIs; the popover says so before the
first container on a machine.

## Lifecycle

- Named `sprintengine-<saved id>` (16 hex) and labelled
  `sprintengine.studio.container=1` and `sprintengine.studio.machine=<id>`.
- Saved before Docker is asked to start it (`provisioning`), so one whose
  making is cut short (Studio quits, the machine goes away) is still listed and
  can be removed.
- Kept on the Docker context it was made under (`docker context show` then),
  named on every later call, so a changed default context cannot lose it.
- Kept after the chat settles. Its server keeps running between turns
  (`keepRunning`); a container Docker stopped (a restart, Colima stopped
  overnight) is started again by the next session (`docker start` in the exec
  channel).
- Removed when its chat is deleted (`container-chat-lifecycle.ts`): once no
  workspace is on a container that one was on, it goes, record and all. A
  container made for a chat that never started is not removed by that sweep;
  it is listed. When removing cannot happen now (Docker not running, the
  machine away) the container is marked as waiting on its record, Settings
  says why, and it is tried again on every registry change and every five
  minutes until it goes. A container is called gone only when Docker answers
  that it has no such container.
- An SSH machine that has containers is not forgotten silently: Studio removes
  them first, or, when the person says the machine is gone, drops only their
  records.
- Settings › Machines › Containers lists every container Studio made: the
  saved ones, and any Docker still has with Studio's label but no record here
  (a crash between start and save), each with Docker's own status words and a
  Remove. Containers are left out of the Machines list above it and out of the
  New chat machine picker.
- Studio removes only containers that carry its label (`removeContainerScript`
  checks it in the same script that removes). It never prunes images.
- Anything that fails after a container started removes it again.

## What the reference does

The reference has no container or sandbox feature for agents: its
devcontainer is for its own development only, and its "sandbox" is each
provider's own permission or sandbox mode. There is no counterpart for the
container, its image, its lifecycle, or bringing changes out of one. What this
design copies from it is the remote-machine model the SSH machines already
follow: the server is installed and started on the other machine and the
client speaks the same protocol to it; a CLI signs in on the machine it runs
on, through the CLI's own login; and git pushes run where the repository is.
Pushing from the host rather than from inside the container is the owner's
ruling, and departs from the reference on purpose: no git credential goes
inside.

## Reaching every surface

A container chat is an SSH-machine chat to every client: the window, a paired
desktop and the phone see and drive it as they do one on an SSH machine.
Making, listing, pushing and removing containers, Docker's status and
Claude Code's token are served on the Studio protocol by the desktop that runs
Docker (`containers.*` and the `containers.changed` stream, capability
`containers`, `packages/studio-protocol/src/containers.ts`). Main holds
`ContainerChats`, since it runs Docker and holds the SSH sessions; the
desktop's Studio forwards each call to it over the shell's control channel when
it runs in a process of its own (`SHELL_METHODS.containers`). The window's New
chat and Settings › Machines › Containers use these methods; there is no IPC
for them.

Who may call them:

| Methods                                 | Who                          | Why                                                                                                                                                                                                                                              |
| --------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `create`                                | an owner's connection        | A container's chat runs on its own Studio (`ssh:<id>`), which paired devices do not reach through this desktop (#602). A device that made one could not follow the chat in it, so it is not offered the making until it can (an owner decision). |
| `push`                                  | an owner's connection        | It pushes with the host's git credentials.                                                                                                                                                                                                       |
| `remove`                                | an owner's connection        | It destroys the container and its chat's work.                                                                                                                                                                                                   |
| `startDocker`                           | an owner's connection        | It starts a VM on the host.                                                                                                                                                                                                                      |
| `status`, `list`, `containers.changed`  | an owner's connection        | The status probes Docker on the host (and may ask an SSH passphrase there); the list names folders on this computer and its SSH machines.                                                                                                        |
| `tokenStatus`, `setToken`, `clearToken` | Studio's own desktop windows | A credential sealed with this computer's keychain, as the tailnet's credential-making methods are.                                                                                                                                               |

So a paired desktop's New chat still shows the Container chip for that machine
with the words "A chat in a container on <machine> is started from <machine>
itself for now", and the phone's New chat shows "No container" with the cube,
saying the same. Windows and WSL say "Containers on … are not built yet".

## Left for later

- Save and resume anywhere (owner idea): `docker commit` the container to an
  image plus the chat's records through the machine hand-over, resumed on any
  machine with Docker. Nothing here designs it out: a container's filesystem is
  its state, and its records are an ordinary machine's.
- A project's devcontainer or Dockerfile as the image.
- A worktree inside a container.
- The host-side proxy that keeps even the token out (above).
- The server and the agent as separate users (Threat model).
- Making and using containers from a paired desktop and the phone: the
  methods are on the protocol; what is left is how a device follows the chat
  in a container it made (an owner decision).
- Push from the chat itself (its pull-request flow), not only from Settings.
- Containers in WSL.
- Network choices other than full.
