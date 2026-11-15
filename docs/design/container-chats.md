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
2. `git bundle create - HEAD --branches --tags` on the host is piped into
   `docker exec -i … git clone` inside the container, at
   `/home/node/work/<folder name>`. Uncommitted changes stay on the host.
3. Inside, `origin` is set back to the host's remote URL (an address only, no
   credential), the copy's author is the host repository's `user.name` and
   `user.email`, and the chat works on a branch of its own,
   `studio/container-<id>`.

The branch leaves the same way, in reverse (`pushOutScript`): `docker exec … git
bundle create - refs/heads/<branch>` on the host, fetched into a ref of
Studio's own (`refs/sprintengine/containers/<id>`) in the host repository, and
pushed with the host's git: `git push origin <that ref>:refs/heads/<branch>`.
The person's branches and working tree are never written. The owner's git and
GitHub credentials never enter the container (the owner's proposal,
implemented): only the host pushes. Push is offered today as "Push branch" on
the container's row in Settings › Machines › Containers.

## Agent sign-in inside the container

Only the agent's own login goes inside. A container chat signs its CLI in the
way an SSH machine's does: the machine's sign-in flow
(`providers.signInStart`, `server/machine/machine-sign-in.ts`) runs the CLI's
own login inside the container and shows its link and code in Studio's dialog
(`claude auth login` pastes a code back; `codex login --device-auth` shows a
device code). The CLI keeps its login where it would on any Linux machine,
inside the container (`~/.claude/.credentials.json`), which is kept with the
chat and removed with it. A CLI with no such flow is told the exact
`docker exec -it <container> <login>` to run once.

The image answers Claude Code's first-run questions once
(`hasCompletedOnboarding` in `~/.claude.json`, no credential) and turns its
self-update off, so a kept container does not stop on them.

Not built yet: a long-lived token from `claude setup-token` (or an API key)
kept in this computer's secret store and handed to the container's server at
start (`docker exec -e CLAUDE_CODE_OAUTH_TOKEN`, value from the docker CLI's
environment, never its argv). A stronger variant keeps even that out: a
placeholder token inside and a proxy on the host that adds the real
`Authorization` header. Either is a later change; the sign-in dialog works now.

## The image

`resources/container/agent.Dockerfile`, shipped with the app
(`extraResources` → `container/`): `node:22-bookworm-slim`, git, ripgrep,
procps, and pinned `@anthropic-ai/claude-code` and `@openai/codex`, running as
the image's unprivileged `node` user (Claude Code refuses to skip its
permission prompts as root). It is built on the container's host the first
time a container is made there (`docker build -` with the Dockerfile on stdin,
no build context) and tagged `sprintengine-studio-agent:<first 12 hex of the
file's SHA-256>`, so an app update that changes the file builds a new image and
an unchanged one is reused. Studio's server brings its own pinned Node; the
image's Node is the project's. The first build takes a few minutes and the
image is about 1.6 GB, mostly the two CLIs; the popover says so before the
first container on a machine.

## Lifecycle

- Named `sprintengine-<saved id>` (16 hex) and labelled
  `sprintengine.studio.container=1` and `sprintengine.studio.machine=<id>`.
- Kept after the chat settles. Its server keeps running between turns
  (`keepRunning`); a container Docker stopped (a restart, Colima stopped
  overnight) is started again by the next session (`docker start` in the exec
  channel).
- Removed when its chat is deleted (`container-chat-lifecycle.ts`): once no
  workspace is on a container that one was on, it goes, record and all. A
  container made for a chat that never started is not removed by that sweep;
  it is listed.
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
Making a container, and pushing its branch, are this desktop's actions (it
runs Docker), like adding an SSH machine; the phone and a paired desktop do not
offer them.

## Left for later

- Save and resume anywhere (owner idea): `docker commit` the container to an
  image plus the chat's records through the machine hand-over, resumed on any
  machine with Docker. Nothing here designs it out: a container's filesystem is
  its state, and its records are an ordinary machine's.
- A project's devcontainer or Dockerfile as the image.
- A worktree inside a container.
- The token path for sign-in, and the host-side proxy variant (above).
- Push from the chat itself (its pull-request flow), not only from Settings.
- Containers in WSL.
- Network choices other than full.
