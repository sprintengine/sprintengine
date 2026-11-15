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

function checkName(name: string): string {
  if (!CONTAINER_NAME.test(name)) throw new Error(`Not a container name Studio made: ${name}`)
  return name
}

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
    '  echo "@@docker ready $v $ctx"',
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
    const context = parts[2] ?? ''
    const via = context === 'colima' || context.startsWith('colima-') ? ' (Colima)' : ''
    return {
      state: 'ready',
      words: `Docker${version ? ` ${version}` : ''} is running on ${where}${via}.`,
      imageReady,
      canStart: null,
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

/** Build Studio's image from the Dockerfile on stdin (no build context: it copies nothing in). */
export function buildImageScript(image: string): string {
  return `docker build -q -t ${checkImage(image)} --label ${IMAGE_LABEL}=agent -`
}

/** Start a chat's container: idle, labelled as Studio's, on Docker's default (full) network. */
export function runContainerScript(input: { name: string; image: string; machineId: string }): string {
  const name = checkName(input.name)
  if (!/^[a-f0-9]{16}$/u.test(input.machineId)) throw new Error('Not a machine id Studio minted.')
  return [
    'docker run -d',
    `--name ${name}`,
    `--hostname ${name}`,
    `--label ${CONTAINER_LABEL}=1`,
    `--label ${CONTAINER_MACHINE_LABEL}=${input.machineId}`,
    '--init',
    checkImage(input.image),
  ].join(' ')
}

/**
 * The container's exec channel, in place of an SSH machine's `sh -s`: started
 * again if Docker stopped it (a restart, Colima stopped overnight), then a
 * shell inside it, as the image's user, reading Studio's script from stdin.
 */
export function execSessionScript(name: string, options: { passEnv?: readonly string[] } = {}): string {
  const checked = checkName(name)
  const pass = (options.passEnv ?? []).map((variable) => {
    if (!/^[A-Z_][A-Z0-9_]{0,63}$/u.test(variable)) throw new Error(`Not a variable name: ${variable}`)
    // By name only: docker takes the value from its own environment, so it is in no command line.
    return ` -e ${variable}`
  })
  return [
    `docker start ${checked} >/dev/null || exit 125`,
    `exec docker exec -i -u ${CONTAINER_USER} -w ${CONTAINER_HOME} -e HOME=${CONTAINER_HOME}${pass.join('')} ${checked} sh -s`,
  ].join('\n')
}

/** Remove a container, only when it carries Studio's label: anything else on the host is never touched. */
export function removeContainerScript(name: string): string {
  const checked = checkName(name)
  return [
    `if ! docker inspect -f '{{.Id}}' ${checked} >/dev/null 2>&1; then echo "@@removed absent"; exit 0; fi`,
    `label="$(docker inspect -f '{{index .Config.Labels "${CONTAINER_LABEL}"}}' ${checked})"`,
    'if [ "$label" != "1" ]; then echo "@@removed not-ours"; exit 3; fi',
    `docker rm -f ${checked} >/dev/null && echo "@@removed yes"`,
  ].join('\n')
}

/** Every container carrying Studio's label: `@@c <name>\t<machine id>\t<status>` each. */
export function listContainersScript(): string {
  return `docker ps -a --filter label=${CONTAINER_LABEL}=1 --format '@@c {{.Names}}\t{{.Label "${CONTAINER_MACHINE_LABEL}"}}\t{{.Status}}'`
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
 * (never a mount, owner ruling 2026-11-15): the host's branches and tags and
 * HEAD, with nothing uncommitted. Inside, the copy's `origin` is set back to
 * the host's own remote URL (an address, no credential), its author is the
 * host's, and the chat works on a branch of its own.
 *
 * Prints `@@repo base <branch>` (empty when HEAD was detached), then
 * `@@repo ok`; `@@repo not-a-repo` when the folder is not one, `@@repo copy-failed`
 * when the copy did not arrive.
 */
export function copyRepoInScript(input: { source: string; name: string; path: string; branch: string }): string {
  const name = checkName(input.name)
  if (!input.path.startsWith(`${CONTAINER_WORK}/`) || /[^A-Za-z0-9._/-]/u.test(input.path))
    throw new Error('Not a work folder Studio chose.')
  if (!/^[A-Za-z0-9._/-]{1,100}$/u.test(input.branch)) throw new Error('Not a branch name Studio chose.')
  const inside = [
    'set -e',
    't="$(mktemp)"',
    'cat > "$t"',
    `git clone -q "$t" ${input.path}`,
    'rm -f "$t"',
    `cd ${input.path}`,
    'if [ -n "$1" ]; then git remote set-url origin "$1"; else git remote remove origin; fi',
    'if [ -n "$2" ]; then git config user.name "$2"; fi',
    'if [ -n "$3" ]; then git config user.email "$3"; fi',
    `git checkout -q -b ${input.branch}`,
  ].join('\n')
  return [
    `src=${shellQuote(input.source)}`,
    'if ! git -C "$src" rev-parse --git-dir >/dev/null 2>&1; then echo "@@repo not-a-repo"; exit 3; fi',
    'base="$(git -C "$src" symbolic-ref -q --short HEAD || true)"',
    'echo "@@repo base $base"',
    'url="$(git -C "$src" remote get-url origin 2>/dev/null || true)"',
    // An address only: a password or token written into the URL (`https://user:token@host/…`) stays here.
    `url="$(printf '%s' "$url" | sed -E 's#^([A-Za-z][A-Za-z0-9+.-]*://)[^/@]*:[^/@]*@#\\1#')"`,
    'who="$(git -C "$src" config user.name || true)"',
    'mail="$(git -C "$src" config user.email || true)"',
    // The pipeline's status is the container's side, which fails when the clone does (an empty bundle too).
    `git -C "$src" bundle create - HEAD --branches --tags 2>/dev/null | docker exec -i -u ${CONTAINER_USER} ${name} sh -c ${shellQuote(inside)} sh "$url" "$who" "$mail" || { echo "@@repo copy-failed"; exit 4; }`,
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
}): string {
  const name = checkName(input.name)
  if (!/^[A-Za-z0-9._/-]{1,100}$/u.test(input.branch)) throw new Error('Not a branch name Studio chose.')
  if (!/^refs\/sprintengine\/containers\/[a-f0-9]{16}$/u.test(input.ref)) throw new Error('Not a ref Studio chose.')
  if (/[^A-Za-z0-9._/-]/u.test(input.path)) throw new Error('Not a work folder Studio chose.')
  return [
    `src=${shellQuote(input.source)}`,
    'if ! git -C "$src" rev-parse --git-dir >/dev/null 2>&1; then echo "@@push no-source"; exit 3; fi',
    't="$(mktemp)"',
    'trap \'rm -f "$t"\' EXIT',
    `if ! docker exec -u ${CONTAINER_USER} ${name} git -C ${input.path} rev-parse -q --verify refs/heads/${input.branch} >/dev/null; then echo "@@push no-branch"; exit 3; fi`,
    `docker exec -u ${CONTAINER_USER} ${name} git -C ${input.path} bundle create - refs/heads/${input.branch} > "$t" 2>/dev/null || { echo "@@push bundle-failed"; exit 3; }`,
    `git -C "$src" fetch -q "$t" "+refs/heads/${input.branch}:${input.ref}" || { echo "@@push fetch-failed"; exit 3; }`,
    `sha="$(git -C "$src" rev-parse ${input.ref})"`,
    `GIT_TERMINAL_PROMPT=0 git -C "$src" push -q origin "${input.ref}:refs/heads/${input.branch}" || { echo "@@push push-failed"; exit 4; }`,
    'echo "@@push ok $sha"',
  ].join('\n')
}
