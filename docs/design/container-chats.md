# Containers

Status: owner's design of 2026-11-15 (the second one: "a container is just a
machine"). It replaces the first cut, which made a disposable container for
each chat. Where the code and this file disagree, fix one of them in the same
change.

## What it is

A container is a machine. It is exactly like an SSH machine, except that
Studio reaches it with `docker exec` rather than `ssh`. A person makes one
with **New container**, on this computer or on any SSH machine that has
Docker (Colima on a Mac is just a Docker host). It is listed in Settings ›
Machines and in New chat's machine picker. Repositories are cloned inside it,
chats there use worktrees, and a chat there has everything a chat on an SSH
machine has, because it is a machine: what SSH machines gain (Files and
terminals in the pane are still to come for them), containers gain with them.
A container lives until the person deletes it.

There is one way to run a chat in a container: pick the container as the
chat's machine.

## New chat: the cube

The cube chip sits beside Worktree in New chat, wearing the still isometric
cube (`ContainerGlyph`, `design-system/glyphs/container.svg`; it never
animates). It reads the picked container's name, or "No container". It opens
a card, "Where this chat runs":

- this computer;
- each container, with the machine it runs on ("on this Mac", "on
  build-box");
- **New container…**, which makes one there and then picks it.

Picking a container is the same as picking it in the machine picker: the
folder is typed as for an SSH machine (`/home/node/work/<repo>`), and
Worktree is offered when that folder is a git repository.

## Making one

New container asks three things: where it runs (this computer, or an SSH
machine), a name, and optionally a repository to clone into
`/home/node/work`. Docker on that machine is said in words, never with a dot
("Docker 29.2.1 is running on this Mac (Colima).", "Colima is installed on
this Mac, but it is stopped." with a **Start Colima** button, "Docker was not
found on build-box.").

Then Studio:

1. builds the image on that machine if it is not there yet (below);
2. saves the container as a machine (`SavedSshEnvironment.container` in
   `userData/ssh-environments.json`) before Docker is asked to start it, so a
   making that is cut short is still listed and can be deleted;
3. starts it: `docker run -d --init --cap-drop ALL --security-opt
no-new-privileges`, as the image's unprivileged `node` user, on Docker's
   default network (full network), labelled `sprintengine.studio.container=1`,
   with the container's own home on a volume (`sprintengine-<id>-home` at
   `/home/node`), and the machine's logins (below);
4. installs and connects Studio's server in it, as for an SSH machine;
5. clones the repository, if one was given.

If any step after the start fails, the container and its home volume are
removed again. Each step is said in words on the container's row while it
runs.

The container is kept on the Docker context it was made under (`docker
context show` then), and that context is named on every later call. A
container Docker stopped (a restart, Colima stopped overnight) is started
again by the next connection.

## How Studio reaches it

A container runs Studio's own server, as an SSH machine does. Everything the
SSH machines built works on it unchanged: the probe, the install of the
pinned Node and the server tree, the managed server, the relay, reconnects,
window tickets, the pane's traffic, the sign-in dialog, worktrees from the
machine's own pool. Only the exec channel differs:

| Machine                     | Exec channel                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------- |
| SSH machine                 | `ssh … -- <machine> sh -s`                                                             |
| Container on this computer  | `/bin/sh -c 'docker start <c> && exec docker exec -i -u node -w /home/node <c> sh -s'` |
| Container on an SSH machine | `ssh … -- <machine> sh -s`, running the same docker lines                              |

Every other Docker action is a short POSIX shell script run on the
container's host (`container/docker-host.ts`, `container/container-scripts.ts`).
Values from outside Studio are single-quoted; container, volume and image
names are Studio's and checked before they are spelled.

A container's chats are recorded as `environment: { kind: 'ssh', id }` and
reached by the `ssh:<id>` route. The route kind `ssh` names "a machine this
desktop saved and reaches over an exec channel it spawns"; a separate route
kind would have to be taught to every file that reads route kinds for no
difference in behaviour. Containers are managed through the same channels as
SSH machines (`SSH_ENV_CHANNELS`), in main, which runs Docker and holds the
sessions.

## Logins

One Docker volume per Docker host, `sprintengine-logins` (labelled
`sprintengine.studio.logins=1`), is mounted at `/studio-logins` in every
container Studio makes on that host. It holds every agent's login and the git
and GitHub credentials, so signing in once on a host serves every container
there, and a container that is deleted or made again keeps them. Each CLI is
pointed there by its own variable, set on the container, read from where that
CLI really writes inside the image (`container/container-logins.ts`). Each
is the CLI's whole folder, not only its login (see Threat model). Once a
container is made or made again, Studio readies the volume: every folder, the
first files (Claude Code's first-run answers, `gh` as git's credential helper)
only where none is yet, and the home's links; a failure there fails the make
or the Rebuild, in words:

| CLI         | Where its login is kept                                                |
| ----------- | ---------------------------------------------------------------------- |
| Claude Code | `CLAUDE_CONFIG_DIR`, with its first-run answers seeded                 |
| Codex       | `CODEX_HOME`                                                           |
| Grok        | `GROK_HOME`                                                            |
| OpenCode    | `XDG_DATA_HOME/opencode`                                               |
| Cursor      | `XDG_CONFIG_HOME/cursor`                                               |
| Muse        | `XDG_CONFIG_HOME/muse`                                                 |
| Kimi Code   | `~/.kimi-code`, a link into the volume                                 |
| GitHub CLI  | `XDG_CONFIG_HOME/gh`                                                   |
| git         | `XDG_CONFIG_HOME/git/config`: `gh` is its credential helper for GitHub |

Signing in uses the machine sign-in dialog (`providers.signInStart`,
`server/machine/machine-sign-in.ts`), from a container's Sign in row in
Settings › Machines or a chat's sign-in failure: each CLI's own login runs
inside the container and its link and code show in Studio (a device code, or
a code pasted back), as does GitHub's (`gh auth login --web`). OpenCode has
no login Studio can run without a terminal; it is told the command. No
credential on the host is ever copied in.

## The image

Written by Studio (`container/container-image.ts`) from the agent CLIs set
up on this computer (what Settings › Agents shows as installed), and built on
the container's host. A base layer (Node 22 pinned by digest, git, ripgrep,
and the GitHub CLI checked against its published digest), then one layer per
agent in a fixed order, so a changed set rebuilds only from its first
difference. Claude Code, Codex, OpenCode and Grok are npm packages at the
versions this build of Studio pins. Cursor, Kimi Code and Muse install only
with their own scripts, which take the newest build when the image is built:
New container says so beside them. Each script installs under `/opt`, outside
the home volume, which a new image would never reach. An agent with no Linux
build at all is left out and said so. The image is tagged by a digest of its
Dockerfile, so a changed set builds a new one and an unchanged one is reused. When which agents
are set up cannot be told (a check failed, or a CLI was being updated), no
image is worked out and New container says why, rather than build one of a
guess.

A container made before the set or a version changed says so in its detail,
and **Rebuild** makes it again on the new image, keeping its home volume
(repositories, worktrees, Studio's server) and the logins. It first says
whether a chat is running in it (one would stop) and asks. The new image must
be there, under the container's own Docker context, before the old container
is removed; the record names the new image only once the new container runs
and its logins are readied, so a Rebuild that fails is offered again. Its server's run
lock, kept in the home, is from before the container started again, and is
taken over (`server/core/data-dir.ts`).

## Deleting one

**Delete container** in Settings › Machines first says what exists only in
the container, and asks: in each repository in its home (four folders deep)
and every worktree of it, branches with commits no remote has, uncommitted or
untracked changes, commits on a detached HEAD on no branch or remote, and
stashes; and whether a chat is running in it. It says only what it looked
at. Deleting removes the container and its home volume, only when they carry
Studio's label. The host's logins volume stays: other containers there use
it. When Docker cannot remove it (not running, the machine away) the record
is kept and the person may forget only the record, which touches nothing in
Docker. A container whose start did not answer in time keeps its record too,
since Docker may still be starting it. An SSH machine with containers on it
is not forgotten silently: each is deleted first, the same way, or, when the
person says the machine is gone, only their records are dropped.

## Paired devices and the phone

A container's chats behave like an SSH machine's: paired devices do not reach
SSH machines through the desktop (owner ruling), so nothing extra is built
for them.

## Threat model

- **Kept out:** the host's folders (no bind mounts), the host's credentials
  of every kind, its SSH agent and keys, every Linux capability and any way to
  regain one.
- **Inside, by design:** the repositories cloned there, whatever an agent
  downloads, and the host's logins volume, which holds more than logins: each
  CLI's whole folder there (Claude Code's, Codex's and Grok's homes with their
  transcripts, history, sessions, settings and hooks; OpenCode's data;
  Cursor's and Muse's configuration; Kimi Code's home folder), the GitHub
  CLI's login, and git's global configuration (`XDG_CONFIG_HOME/git/config`).
  Every container on that host mounts it, so an agent in any of them can read
  and change all of it (and send it anywhere: the network is full), and it
  stays when a container is deleted. Delete says so.
- **Known gap:** the agent and Studio's server run as the same user, so an
  agent can drive its own container's server. The desktop already holds that
  server to what it holds an SSH machine's server to.

## Containers from the first cut

The first cut's per-chat containers are not migrated. Their records still
read as container machines: each is listed in Settings › Machines and can be
deleted there.

## Left for later

- Disposable per-chat containers.
- Copying a repository on this computer into a container.
- Saving a container and moving it to another machine.
- A credential proxy that keeps even the logins out.
- Network allow-lists.
- A project's devcontainer or Dockerfile as the image.
- Containers in WSL.
