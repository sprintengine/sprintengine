import {
  CONTAINER_LABEL,
  CONTAINER_MACHINE_LABEL,
  CONTAINER_NAME,
  IMAGE_LABEL,
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
/** Where a chat's repository is copied to inside its container. */
export const CONTAINER_WORK = '/home/node/work'
/**
 * The agent's user and group by number, which Studio's server inside starts
 * every program as (`--agent-uid`, `--agent-gid`): the image's `node` user.
 */
export const CONTAINER_AGENT_IDS = { uid: 1000, gid: 1000 } as const
/**
 * Where Studio's server is installed in a container whose server and agent
 * are separate users: owned by root and readable by all, so the agent can run
 * the MCP bridge from it and cannot change it. Its data stays in root's own
 * home, which the agent cannot enter.
 */
export const CONTAINER_SERVER_INSTALL_DIR = '/opt/sprintengine-studio'
/**
 * The capabilities the server needs to start each program as the agent's
 * user (SETUID, SETGID) and to stop it (KILL); every other one is dropped,
 * and none can be gained (`no-new-privileges`). A process of the agent's user
 * holds none of them.
 */
export const CONTAINER_SERVER_CAPABILITIES = ['SETUID', 'SETGID', 'KILL'] as const

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

/**
 * Start a chat's container: idle, labelled as Studio's, on Docker's default
 * (full) network, with every Linux capability dropped but the three Studio's
 * server needs to start its programs as the agent's user, and no way to gain
 * one through a setuid program. Only the server, run as root, holds those
 * three; the agent's processes hold none.
 */
export function runContainerScript(input: {
  name: string
  image: string
  machineId: string
  context?: string | null
}): string {
  const name = checkName(input.name)
  if (!/^[a-f0-9]{16}$/u.test(input.machineId)) throw new Error('Not a machine id Studio minted.')
  return [
    `${dockerCommand(input.context)} run -d`,
    `--name ${name}`,
    `--hostname ${name}`,
    `--label ${CONTAINER_LABEL}=1`,
    `--label ${CONTAINER_MACHINE_LABEL}=${input.machineId}`,
    '--init',
    '--cap-drop ALL',
    ...CONTAINER_SERVER_CAPABILITIES.map((capability) => `--cap-add ${capability}`),
    '--security-opt no-new-privileges',
    checkImage(input.image),
  ].join(' ')
}

/** The line the exec channel prints just before it becomes the container's shell (see `hostRunner`'s `holdUntil`). */
export const EXEC_READY_MARKER = '@@CONTAINER_EXEC'

/**
 * The container's exec channel, in place of an SSH machine's `sh -s`: started
 * again if Docker stopped it (a restart, Colima stopped overnight), then a
 * shell inside it reading Studio's script from stdin. As root, in root's own
 * home, for a container whose server and agent are separate users (its
 * server's data is root's, and the server starts the agent as `node`); as
 * the image's user for one made before they were (`separateUsers` unset).
 */
export function execSessionScript(
  name: string,
  options: { passEnv?: readonly string[]; context?: string | null; separateUsers?: boolean } = {},
): string {
  const checked = checkName(name)
  const docker = dockerCommand(options.context)
  const pass = (options.passEnv ?? []).map((variable) => {
    if (!/^[A-Z_][A-Z0-9_]{0,63}$/u.test(variable)) throw new Error(`Not a variable name: ${variable}`)
    // By name only: docker takes the value from its own environment, so it is in no command line.
    return ` -e ${variable}`
  })
  return [
    `${docker} start ${checked} >/dev/null || exit 125`,
    // Nothing more is read by this shell: what follows on stdin is the container's.
    `echo ${EXEC_READY_MARKER}`,
    options.separateUsers
      ? `exec ${docker} exec -i -u 0 -w /root -e HOME=/root${pass.join('')} ${checked} sh -s`
      : `exec ${docker} exec -i -u ${CONTAINER_USER} -w ${CONTAINER_HOME} -e HOME=${CONTAINER_HOME}${pass.join('')} ${checked} sh -s`,
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
    '    *"No such object"*|*"No such container"*) echo "@@removed absent"; exit 0 ;;',
    '  esac',
    '  echo "@@removed failed"; echo "$said" >&2; exit 4',
    'fi',
    'if [ "$said" != "1" ]; then echo "@@removed not-ours"; exit 3; fi',
    `${docker} rm -f ${checked} >/dev/null && echo "@@removed yes"`,
  ].join('\n')
}

/** Every container carrying Studio's label: `@@c <name>\t<machine id>\t<status>` each. */
export function listContainersScript(context: string | null = null): string {
  return `${dockerCommand(context)} ps -a --filter label=${CONTAINER_LABEL}=1 --format '@@c {{.Names}}\t{{.Label "${CONTAINER_MACHINE_LABEL}"}}\t{{.Status}}'`
}

export type ListedContainer = { name: string; machineId: string | null; status: string }

export function parseContainerList(stdout: string): ListedContainer[] {
  const out: ListedContainer[] = []
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('@@c ')) continue
    const [name = '', machineId = '', status = ''] = line.slice(4).split('\t')
    if (!CONTAINER_NAME.test(name)) continue
    out.push({ name, machineId: /^[a-f0-9]{16}$/u.test(machineId) ? machineId : null, status: status.trim() })
  }
  return out
}

/** A folder's last part as a directory name inside the container: plain characters only. */
export function workFolderName(source: string | null): string {
  const last =
    (source ?? '')
      .replace(/[\\/]+$/u, '')
      .split(/[\\/]/u)
      .pop() ?? ''
  const clean = last.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^[.-]+/u, '')
  return clean.slice(0, 64) || 'project'
}

/** Whether a folder on the host is a git repository: `@@repo yes` or `@@repo no`. */
export function isRepositoryScript(source: string): string {
  return `if git -C ${shellQuote(source)} rev-parse --git-dir >/dev/null 2>&1; then echo "@@repo yes"; else echo "@@repo no"; fi`
}

/**
 * Copy a repository into the container as a git bundle streamed from the host
 * (never a mount, owner ruling 2026-11-15): HEAD and the branch it is on,
 * with nothing uncommitted. Inside, the copy's `origin` is set back to the
 * host's own remote URL (an address, no credential), its author is the
 * host's, and the chat works on a branch of its own.
 *
 * Prints `@@repo base <branch>` (empty when HEAD was detached), then
 * `@@repo ok`; `@@repo not-a-repo` when the folder is not one, `@@repo copy-failed`
 * when the copy did not arrive.
 */
export function copyRepoInScript(input: {
  source: string
  name: string
  path: string
  branch: string
  context?: string | null
}): string {
  const name = checkName(input.name)
  const docker = dockerCommand(input.context)
  if (!input.path.startsWith(`${CONTAINER_WORK}/`) || /[^A-Za-z0-9._/-]/u.test(input.path))
    throw new Error('Not a work folder Studio chose.')
  if (!/^[A-Za-z0-9._/-]{1,100}$/u.test(input.branch)) throw new Error('Not a branch name Studio chose.')
  // Inside, three lines first (the remote's address, the author's name and
  // email: on stdin, never in a command line), then the bundle.
  const inside = [
    'set -e',
    // The agent's and its server's shared group may read and write the copy
    // (the server's file explorer writes into it); nobody else may.
    'umask 007',
    'IFS= read -r url',
    'IFS= read -r who',
    'IFS= read -r mail',
    't="$(mktemp)"',
    'cat > "$t"',
    `git clone -q "$t" ${input.path}`,
    'rm -f "$t"',
    `cd ${input.path}`,
    'if [ -n "$url" ]; then git remote set-url origin "$url"; else git remote remove origin; fi',
    'if [ -n "$who" ]; then git config user.name "$who"; fi',
    'if [ -n "$mail" ]; then git config user.email "$mail"; fi',
    `git checkout -q -b ${input.branch}`,
  ].join('\n')
  return [
    `src=${shellQuote(input.source)}`,
    'if ! git -C "$src" rev-parse --git-dir >/dev/null 2>&1; then echo "@@repo not-a-repo"; exit 3; fi',
    'base="$(git -C "$src" symbolic-ref -q --short HEAD || true)"',
    'echo "@@repo base $base"',
    'url="$(git -C "$src" remote get-url origin 2>/dev/null || true)"',
    // An address only. Over http(s) anything before `@` is a credential (`https://TOKEN@host/…`,
    // `https://user:token@host/…`) and stays here; elsewhere a user name is kept and a password dropped.
    `url="$(printf '%s' "$url" | sed -E -e 's#^([Hh][Tt][Tt][Pp][Ss]?://)[^/@]*@#\\1#' -e 's#^([A-Za-z][A-Za-z0-9+.-]*://[^/@:]*):[^/@]*@#\\1@#')"`,
    'who="$(git -C "$src" config user.name || true)"',
    'mail="$(git -C "$src" config user.email || true)"',
    // Only what the chat starts from: HEAD and the branch it is on, not every branch and tag here.
    'if [ -n "$base" ]; then refs="refs/heads/$base"; else refs=""; fi',
    // The pipeline's status is the container's side, which fails when the clone does (an empty bundle too).
    `{ printf '%s\\n%s\\n%s\\n' "$url" "$who" "$mail"; git -C "$src" bundle create - HEAD $refs 2>/dev/null; } | ${docker} exec -i -u ${CONTAINER_USER} ${name} sh -c ${shellQuote(inside)} || { echo "@@repo copy-failed"; exit 4; }`,
    'echo "@@repo ok"',
  ].join('\n')
}

/**
 * Bring the chat's branch out of the container and push it from the host
 * (owner proposal 2026-11-15): the branch travels as a bundle over Docker's
 * own channel into a ref of Studio's in the host's repository, and the host's
 * git pushes it with the host's own credentials. Nothing is written to the
 * person's branches or working tree. Prints `@@push ok <sha>` or `@@push <why>`.
 */
export function pushOutScript(input: {
  source: string
  name: string
  path: string
  branch: string
  ref: string
  context?: string | null
}): string {
  const name = checkName(input.name)
  const docker = dockerCommand(input.context)
  if (!/^[A-Za-z0-9._/-]{1,100}$/u.test(input.branch)) throw new Error('Not a branch name Studio chose.')
  if (!/^refs\/sprintengine\/containers\/[a-f0-9]{16}$/u.test(input.ref)) throw new Error('Not a ref Studio chose.')
  if (/[^A-Za-z0-9._/-]/u.test(input.path)) throw new Error('Not a work folder Studio chose.')
  return [
    `src=${shellQuote(input.source)}`,
    'if ! git -C "$src" rev-parse --git-dir >/dev/null 2>&1; then echo "@@push no-source"; exit 3; fi',
    't="$(mktemp)"',
    'trap \'rm -f "$t"\' EXIT',
    `if ! ${docker} exec -u ${CONTAINER_USER} ${name} git -C ${input.path} rev-parse -q --verify refs/heads/${input.branch} >/dev/null; then echo "@@push no-branch"; exit 3; fi`,
    `${docker} exec -u ${CONTAINER_USER} ${name} git -C ${input.path} bundle create - refs/heads/${input.branch} > "$t" 2>/dev/null || { echo "@@push bundle-failed"; exit 3; }`,
    // Every object the container sends is checked before it lands in the person's repository.
    `git -C "$src" -c fetch.fsckObjects=true fetch -q "$t" "+refs/heads/${input.branch}:${input.ref}" || { echo "@@push fetch-failed"; exit 3; }`,
    `sha="$(git -C "$src" rev-parse ${input.ref})"`,
    `GIT_TERMINAL_PROMPT=0 git -C "$src" push -q origin "${input.ref}:refs/heads/${input.branch}" || { echo "@@push push-failed"; exit 4; }`,
    'echo "@@push ok $sha"',
  ].join('\n')
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
  if (said === 'no-docker')
    return {
      ok: false,
      message: `Docker is not running on ${where}, so ${name} is still there. Studio removes it once Docker answers again.`,
    }
  const last = result.stderr.trim().split('\n').filter(Boolean).pop()?.trim()
  if (result.code === null) return { ok: false, message: `${where} did not answer in time, so ${name} is still there.` }
  return { ok: false, message: `${name} could not be removed on ${where}${last ? `: ${last}` : '.'}` }
}
