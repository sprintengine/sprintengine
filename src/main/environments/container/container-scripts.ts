import {
  CONTAINER_LABEL,
  CONTAINER_MACHINE_LABEL,
  CONTAINER_NAME,
  IMAGE_LABEL,
  type ContainerWork,
  type DockerStatus,
} from '../../../shared/containers'
import { shellQuote } from './docker-host'

// The shell scripts a container's host runs (docs/design/container-chats.md),
// as pure functions of what they act on, so each is read and tested here.
// Every one is POSIX `sh`, runs as the person on their own machine (this
// computer, or an SSH machine over their own ssh), and spells nothing bare
// but names Studio minted: a value from anywhere else is `shellQuote`d.
//
// Each prints its findings as `@@` lines, the way the SSH bootstrap does, so a
// login profile's greeting on an SSH machine is never mistaken for an answer.

/** The user every agent runs as inside the image (resources/container/agent.Dockerfile). */
export const CONTAINER_USER = 'node'
export const CONTAINER_HOME = '/home/node'
/** Where repositories are cloned inside a container. */
export const CONTAINER_WORK = '/home/node/work'

function checkName(name: string): string {
  if (!CONTAINER_NAME.test(name)) throw new Error(`Not a container name Studio made: ${name}`)
  return name
}

/**
 * Docker's command on a host for one Docker context: the context a container
 * was made under is saved with it and named on every later call, so a person
 * switching their default context (Colima to Docker Desktop, say) does not
 * send Studio looking for its containers in the wrong engine. No context, or
 * `default`, is the host's own default (which `DOCKER_HOST` may point).
 */
export function dockerCommand(context: string | null | undefined): string {
  if (!context || context === 'default') return 'docker'
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(context)) throw new Error(`Not a Docker context name: ${context}`)
  return `docker --context ${context}`
}

/** A heredoc delimiter no Dockerfile line will be. */
const DOCKERFILE_END = 'SPRINTENGINE_DOCKERFILE_END_7f3a'

function checkImage(image: string): string {
  if (!/^[a-z0-9][a-z0-9._/-]{0,127}:[A-Za-z0-9._-]{1,128}$/u.test(image)) throw new Error(`Not an image tag: ${image}`)
  return image
}

/** Docker on the host, and whether `image` is there: `@@docker <state> …` and `@@image present|absent`. */
export function dockerStatusScript(image: string): string {
  const tag = checkImage(image)
  return [
    'if ! command -v docker >/dev/null 2>&1; then',
    '  if command -v colima >/dev/null 2>&1; then echo "@@docker missing colima"; else echo "@@docker missing"; fi',
    '  exit 0',
    'fi',
    `v="$(docker version --format '{{.Server.Version}}' 2>/dev/null)"`,
    'if [ -n "$v" ]; then',
    '  ctx="$(docker context show 2>/dev/null)"',
    '  echo "@@docker ready $v"',
    '  echo "@@context $ctx"',
    `  if docker image inspect ${tag} >/dev/null 2>&1; then echo "@@image present"; else echo "@@image absent"; fi`,
    '  exit 0',
    'fi',
    'if command -v colima >/dev/null 2>&1; then',
    '  if colima status >/dev/null 2>&1; then echo "@@docker not-running colima-up"; else echo "@@docker stopped colima"; fi',
    'else',
    '  echo "@@docker not-running"',
    'fi',
  ].join('\n')
}

/** What `dockerStatusScript` printed, in the popover's words. `where` is "this Mac" or the SSH machine's name. */
export function parseDockerStatus(stdout: string, where: string): DockerStatus {
  const line = stdout
    .split('\n')
    .map((each) => each.trim())
    .find((each) => each.startsWith('@@docker '))
  const imageReady = /^@@image present$/mu.test(stdout)
  const parts = (line ?? '').split(/\s+/u).slice(1)
  const state = parts[0]
  if (state === 'ready') {
    const version = parts[1] ?? ''
    const named = /^@@context (\S+)$/mu.exec(stdout)?.[1] ?? null
    const context = named && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(named) ? named : null
    const via = context === 'colima' || context?.startsWith('colima-') ? ' (Colima)' : ''
    return {
      state: 'ready',
      words: `Docker${version ? ` ${version}` : ''} is running on ${where}${via}.`,
      imageReady,
      canStart: null,
      context,
    }
  }
  if (state === 'stopped')
    return {
      state: 'stopped',
      words: `Colima is installed on ${where}, but it is stopped.`,
      imageReady: false,
      canStart: 'colima',
    }
  if (state === 'not-running')
    return {
      state: 'not-running',
      words:
        parts[1] === 'colima-up'
          ? `Colima is running on ${where}, but Docker does not answer.`
          : `Docker is installed on ${where}, but it is not running.`,
      imageReady: false,
      canStart: null,
    }
  if (state === 'missing')
    return {
      state: 'missing',
      words:
        parts[1] === 'colima'
          ? `Colima is on ${where}, but Docker's command is not.`
          : `Docker was not found on ${where}.`,
      imageReady: false,
      canStart: null,
    }
  return {
    state: 'unreachable',
    words: `Studio could not ask ${where} about Docker.`,
    imageReady: false,
    canStart: null,
  }
}

/** Start Colima with its own saved settings; nothing about its size is changed. */
export function startColimaScript(): string {
  return 'colima start'
}

/**
 * Build Studio's image from its Dockerfile, carried in the script itself (no
 * build context: it copies nothing in), so the script is all a host is sent.
 */
export function buildImageScript(image: string, dockerfile: string, context: string | null = null): string {
  if (dockerfile.split('\n').some((line) => line.trim() === DOCKERFILE_END))
    throw new Error('The Dockerfile holds the line that ends it.')
  return [
    `${dockerCommand(context)} build -q -t ${checkImage(image)} --label ${IMAGE_LABEL}=agent - <<'${DOCKERFILE_END}'`,
    dockerfile.replace(/\n$/u, ''),
    DOCKERFILE_END,
  ].join('\n')
}

/** The volume that is a container's home: its repositories, worktrees and Studio's server, kept across a rebuild. */
export function homeVolumeName(name: string): string {
  return `${checkName(name)}-home`
}

/**
 * Start a container: idle, labelled as Studio's, on Docker's default (full)
 * network, with every Linux capability dropped and no way to gain one through
 * a setuid program: nothing in it runs as root. Its home is a volume of its
 * own, made first with Studio's label, so a container made again from a new
 * image keeps its repositories, and deleting it removes only Studio's.
 */
export function runContainerScript(input: {
  name: string
  image: string
  machineId: string
  context?: string | null
}): string {
  const name = checkName(input.name)
  if (!/^[a-f0-9]{16}$/u.test(input.machineId)) throw new Error('Not a machine id Studio minted.')
  const docker = dockerCommand(input.context)
  const home = homeVolumeName(name)
  return [
    `${docker} volume create --label ${CONTAINER_LABEL}=1 --label ${CONTAINER_MACHINE_LABEL}=${input.machineId} ${home} >/dev/null || exit 4`,
    [
      `${docker} run -d`,
      `--name ${name}`,
      `--hostname ${name}`,
      `--label ${CONTAINER_LABEL}=1`,
      `--label ${CONTAINER_MACHINE_LABEL}=${input.machineId}`,
      '--init',
      '--cap-drop ALL',
      '--security-opt no-new-privileges',
      `-v ${home}:${CONTAINER_HOME}`,
      checkImage(input.image),
    ].join(' '),
  ].join('\n')
}

/** The line the exec channel prints just before it becomes the container's shell (see `hostRunner`'s `holdUntil`). */
export const EXEC_READY_MARKER = '@@CONTAINER_EXEC'

/**
 * The container's exec channel, in place of an SSH machine's `sh -s`: started
 * again if Docker stopped it (a restart, Colima stopped overnight), then a
 * shell inside it, as the image's user, reading Studio's script from stdin.
 */
export function execSessionScript(name: string, options: { context?: string | null } = {}): string {
  const checked = checkName(name)
  const docker = dockerCommand(options.context)
  return [
    `${docker} start ${checked} >/dev/null || exit 125`,
    // Nothing more is read by this shell: what follows on stdin is the container's.
    `echo ${EXEC_READY_MARKER}`,
    `exec ${docker} exec -i -u ${CONTAINER_USER} -w ${CONTAINER_HOME} -e HOME=${CONTAINER_HOME} ${checked} sh -s`,
  ].join('\n')
}

/**
 * Remove a container, only when it carries Studio's label: anything else on
 * the host is never touched. Docker must answer first: a container is called
 * gone only when Docker says it has no such container, never because Docker
 * was not running. Prints `@@removed yes|absent|not-ours|no-docker|failed`.
 */
export function removeContainerScript(name: string, context: string | null = null): string {
  const checked = checkName(name)
  const docker = dockerCommand(context)
  return [
    `if ! ${docker} version --format '{{.Server.Version}}' >/dev/null 2>&1; then echo "@@removed no-docker"; exit 4; fi`,
    `if ! said="$(${docker} inspect -f '{{index .Config.Labels "${CONTAINER_LABEL}"}}' ${checked} 2>&1)"; then`,
    '  case "$said" in',
    `    *"No such object"*|*"No such container"*) ${removeHomeVolume(docker, checked)}; echo "@@removed absent"; exit 0 ;;`,
    '  esac',
    '  echo "@@removed failed"; echo "$said" >&2; exit 4',
    'fi',
    'if [ "$said" != "1" ]; then echo "@@removed not-ours"; exit 3; fi',
    `${docker} rm -f ${checked} >/dev/null || { echo "@@removed failed"; exit 4; }`,
    removeHomeVolume(docker, checked),
    'echo "@@removed yes"',
  ].join('\n')
}

/** The container's home volume goes with it, only when it carries Studio's label; one already gone is fine. */
function removeHomeVolume(docker: string, name: string): string {
  const home = homeVolumeName(name)
  return `if [ "$(${docker} volume inspect -f '{{index .Labels "${CONTAINER_LABEL}"}}' ${home} 2>/dev/null)" = "1" ]; then ${docker} volume rm ${home} >/dev/null; fi`
}

/**
 * A repository's address as a person types it, checked and spelled as git
 * takes it: `https://…`, `ssh://…`, `git@host:owner/repo`, or `owner/repo`,
 * which is GitHub's. Null when it is none of these.
 */
export function cloneAddress(typed: string): string | null {
  const value = typed.trim()
  if (!value || value.length > 2048 || /[\s\0]/u.test(value)) return null
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)) return `https://github.com/${value.replace(/\.git$/u, '')}.git`
  if (/^(?:https?|ssh|git):\/\/[^/]+\/.+/u.test(value)) return value
  if (/^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:[^/].*/u.test(value)) return value
  return null
}

/** The folder a clone lands in under `CONTAINER_WORK`: the address's last part, plain characters only. */
export function cloneFolderName(address: string): string {
  const last =
    address
      .replace(/[\\/]+$/u, '')
      .replace(/\.git$/u, '')
      .split(/[\\/:]/u)
      .pop() ?? ''
  const clean = last.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^[.-]+/u, '')
  return clean.slice(0, 64) || 'repo'
}

/**
 * Clone a repository inside a container, into `CONTAINER_WORK/<folder>`, as
 * the agent's user, with the container's own credentials (none of the
 * host's). git never stops to ask for a password: a repository it cannot
 * reach fails in words. Prints `@@clone ok <path>`, `@@clone exists <path>`
 * or `@@clone failed`.
 */
export function cloneScript(input: { name: string; address: string; folder: string; context?: string | null }): string {
  const name = checkName(input.name)
  const docker = dockerCommand(input.context)
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(input.folder) || input.folder.startsWith('.'))
    throw new Error('Not a folder name Studio chose.')
  const path = `${CONTAINER_WORK}/${input.folder}`
  const inside = [
    `mkdir -p ${CONTAINER_WORK}`,
    `if [ -e ${path} ]; then echo "@@clone exists ${path}"; exit 3; fi`,
    `GIT_TERMINAL_PROMPT=0 git clone -q -- "$1" ${path} && echo "@@clone ok ${path}"`,
  ].join('\n')
  return [
    `${docker} start ${name} >/dev/null || exit 125`,
    `${docker} exec -u ${CONTAINER_USER} -e HOME=${CONTAINER_HOME} -w ${CONTAINER_HOME} ${name} sh -c ${shellQuote(inside)} sh ${shellQuote(input.address)} || echo "@@clone failed"`,
  ].join('\n')
}

/**
 * Everything in the container's repositories that exists nowhere else, what
 * deleting the container would lose. Looks in the home's folders (not its
 * hidden ones, where Studio's server and the CLIs keep their own), four deep,
 * and in every worktree of each repository found:
 *
 *   @@branch <commits>\t<repo>\t<branch>     a branch with commits no remote has
 *   @@dirty <files>\t<worktree>              uncommitted or untracked changes
 *   @@detached <commits>\t<worktree>         a detached HEAD's commits on no branch or remote
 *   @@stash <count>\t<repo>                  stashed changes
 *
 * then `@@done`, so an answer cut short is never read as "nothing".
 */
export function unpushedScript(name: string, context: string | null = null): string {
  const checked = checkName(name)
  const docker = dockerCommand(context)
  const inside = [
    `find ${CONTAINER_HOME} -maxdepth 4 \\( -name node_modules -o -path '${CONTAINER_HOME}/.*' \\) -prune -o -type d -name .git -print 2>/dev/null |`,
    'while IFS= read -r g; do',
    '  r="${g%/.git}"',
    '  git -C "$r" for-each-ref --format=\'%(refname:short)\' refs/heads | while IFS= read -r b; do',
    '    n="$(git -C "$r" rev-list --count "refs/heads/$b" --not --remotes 2>/dev/null)"',
    '    if [ -n "$n" ] && [ "$n" -gt 0 ]; then printf \'@@branch %s\\t%s\\t%s\\n\' "$n" "$r" "$b"; fi',
    '  done',
    '  n="$(git -C "$r" stash list 2>/dev/null | wc -l | tr -d " ")"',
    '  if [ -n "$n" ] && [ "$n" -gt 0 ]; then printf \'@@stash %s\\t%s\\n\' "$n" "$r"; fi',
    '  git -C "$r" worktree list --porcelain 2>/dev/null | sed -n \'s/^worktree //p\' | while IFS= read -r w; do',
    '    [ -d "$w" ] || continue',
    '    n="$(git -C "$w" status --porcelain 2>/dev/null | wc -l | tr -d " ")"',
    '    if [ -n "$n" ] && [ "$n" -gt 0 ]; then printf \'@@dirty %s\\t%s\\n\' "$n" "$w"; fi',
    '    if ! git -C "$w" symbolic-ref -q HEAD >/dev/null 2>&1; then',
    '      n="$(git -C "$w" rev-list --count HEAD --not --branches --remotes 2>/dev/null)"',
    '      if [ -n "$n" ] && [ "$n" -gt 0 ]; then printf \'@@detached %s\\t%s\\n\' "$n" "$w"; fi',
    '    fi',
    '  done',
    'done',
    'echo "@@done"',
  ].join('\n')
  return [
    `${docker} start ${checked} >/dev/null || exit 125`,
    `${docker} exec -u ${CONTAINER_USER} -e HOME=${CONTAINER_HOME} ${checked} sh -c ${shellQuote(inside)}`,
  ].join('\n')
}

/** What `unpushedScript` printed: null when it did not finish (Docker did not answer). */
export function parseUnpushed(stdout: string): Omit<ContainerWork, 'chatsRunning'> | null {
  if (!/^@@done$/mu.test(stdout)) return null
  const work: Omit<ContainerWork, 'chatsRunning'> = { branches: [], dirty: [], detached: [], stashes: [] }
  for (const line of stdout.split('\n')) {
    const said = /^@@(branch|dirty|detached|stash) (\d+)\t([^\t]+)(?:\t(.+))?$/u.exec(line.trimEnd())
    if (!said) continue
    const count = Number.parseInt(said[2]!, 10)
    if (!(count > 0)) continue
    const path = said[3]!
    if (said[1] === 'branch' && said[4]) work.branches.push({ repo: path, branch: said[4], commits: count })
    if (said[1] === 'dirty') work.dirty.push({ worktree: path, files: count })
    if (said[1] === 'detached') work.detached.push({ worktree: path, commits: count })
    if (said[1] === 'stash') work.stashes.push({ repo: path, count })
  }
  return work
}

/** What `removeContainerScript` said, in words: `ok` only when the container is gone. */
export function removalOutcome(
  result: { stdout: string; stderr: string; code: number | null },
  name: string,
  where: string,
): { ok: true } | { ok: false; message: string } {
  const said = /^@@removed (\S+)/mu.exec(result.stdout)?.[1]
  if (said === 'yes' || said === 'absent') return { ok: true }
  if (said === 'not-ours')
    return { ok: false, message: `${name} is not a container Studio made, so it was left alone.` }
  // Nothing removes it later: the person deletes it again once Docker answers, or forgets its record.
  const after = `Delete it again once Docker answers there, or forget only its record.`
  if (said === 'no-docker')
    return { ok: false, message: `Docker is not running on ${where}, so ${name} is still there. ${after}` }
  const last = result.stderr.trim().split('\n').filter(Boolean).pop()?.trim()
  if (result.code === null)
    return { ok: false, message: `${where} did not answer in time, so ${name} is still there. ${after}` }
  return { ok: false, message: `${name} could not be removed on ${where}${last ? `: ${last}` : '.'} ${after}` }
}
