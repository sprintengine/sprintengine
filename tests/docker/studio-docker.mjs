#!/usr/bin/env node
// Independent SprintEngine Studio instances in Docker, for test agents that
// drive the window over the Chrome DevTools Protocol. tests/docker/README.md
// says what each topology is and how to drive one.
//
//   node tests/docker/studio-docker.mjs build                  build the images from this checkout
//   node tests/docker/studio-docker.mjs up <topology> [--name <stack>] [--json]
//   node tests/docker/studio-docker.mjs ls
//   node tests/docker/studio-docker.mjs smoke <stack>
//   node tests/docker/studio-docker.mjs open-dir <stack> <desktop> <path>
//   node tests/docker/studio-docker.mjs pair <stack>                a fresh pairing link (web topology)
//   node tests/docker/studio-docker.mjs down <stack>... | --all
//
// Every container, network and port it makes carries the label
// `studio-harness.stack=<stack>`, so `down` removes exactly what `up` made, and
// a failed `up` removes what it had made before it fails. Ports are published
// on 127.0.0.1 only, on free ports `up` picks and writes into the container,
// so they stay the same across `docker restart` (the web topology's is also
// the same number inside, because the web client checks its origin's port).

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')

const LABEL = 'studio-harness.stack'
const APP_IMAGE = 'sprintengine-studio-app:latest'
const DESKTOP_IMAGE = 'sprintengine-studio-desktop:latest'
const SSHD_IMAGE = 'sprintengine-test-sshd:1'
const SSH_MACHINE_IMAGE = 'sprintengine-studio-ssh-machine:latest'
/** What one desktop may use; the VM is shared by every stack and by other work. */
const DESKTOP_MEMORY = process.env.STUDIO_DOCKER_MEMORY ?? '1536m'
const DESKTOP_CPUS = process.env.STUDIO_DOCKER_CPUS ?? '2'
const READY_MS = 120_000

const TOPOLOGIES = {
  single: { desktops: ['desk-a'], ssh: false, summary: 'one desktop' },
  ssh: { desktops: ['desk-a'], ssh: true, summary: 'a desktop and an SSH machine (build-box)' },
  paired: { desktops: ['desk-a', 'desk-b'], ssh: false, summary: 'two desktops on a stand-in tailnet, to pair' },
  web: { desktops: [], ssh: false, web: true, summary: 'the headless server, serving the web client' },
}

function docker(args, options = {}) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options }).trim()
}
function dockerOk(args) {
  return spawnSync('docker', args, { stdio: 'ignore' }).status === 0
}
const hasImage = (image) => dockerOk(['image', 'inspect', image])
const say = (line) => process.stderr.write(`${line}\n`)
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

// ── build ────────────────────────────────────────────────────────────────

/** The checkout's files (tracked, and new ones not ignored), without the phone app, as a tar. */
function sourceTar() {
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  })
    .toString('utf8')
    .split('\0')
    .filter((file) => file && !file.startsWith('mobile/') && existsSync(join(root, file)))
    // The harness's own files go in the desktop image's last layer (harness.Dockerfile), so
    // changing them does not rebuild the app; only the app's Dockerfile travels here.
    .filter((file) => !file.startsWith('tests/docker/') || file === 'tests/docker/app.Dockerfile')
  // No macOS extended attributes: Docker cannot set them and refuses the context.
  return execFileSync('tar', ['--no-xattrs', '--no-mac-metadata', '-cf', '-', '-T', '-'], {
    cwd: root,
    input: files.join('\n'),
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    maxBuffer: 1024 * 1024 * 1024,
  })
}

function commitOf() {
  const head = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout.trim()
  return `${head || 'unknown'}${dirty ? '-dirty' : ''}`
}

function build() {
  const run = (args, input) => {
    const result = spawnSync('docker', args, { input, stdio: [input ? 'pipe' : 'ignore', 'inherit', 'inherit'] })
    if (result.status !== 0) throw new Error(`docker ${args.slice(0, 3).join(' ')} … failed`)
  }
  say(`studio-docker: building ${APP_IMAGE} from this checkout (${commitOf()}); the first build takes several minutes`)
  run(
    [
      'build',
      '-q',
      '-t',
      APP_IMAGE,
      '--build-arg',
      `STUDIO_COMMIT=${commitOf()}`,
      '-f',
      'tests/docker/app.Dockerfile',
      '-',
    ],
    sourceTar(),
  )
  run([
    'build',
    '-q',
    '-t',
    DESKTOP_IMAGE,
    '--build-arg',
    `APP_IMAGE=${APP_IMAGE}`,
    '-f',
    join(here, 'harness.Dockerfile'),
    here,
  ])
  if (!hasImage(SSHD_IMAGE)) {
    const fixtures = join(root, 'src', 'main', 'environments', 'ssh', '__fixtures__')
    run(['build', '-q', '-t', SSHD_IMAGE, '-f', join(fixtures, 'sshd.Dockerfile'), fixtures])
  }
  run([
    'build',
    '-q',
    '-t',
    SSH_MACHINE_IMAGE,
    '--build-arg',
    `SSHD_IMAGE=${SSHD_IMAGE}`,
    '-f',
    join(here, 'ssh-machine.Dockerfile'),
    here,
  ])
  say('studio-docker: images built')
}

// ── up ───────────────────────────────────────────────────────────────────

function stacks() {
  const out = docker(['ps', '-a', '--filter', `label=${LABEL}`, '--format', `{{.Label "${LABEL}"}}`])
  const nets = docker(['network', 'ls', '--filter', `label=${LABEL}`, '--format', `{{.Label "${LABEL}"}}`])
  return [...new Set([...out.split('\n'), ...nets.split('\n')].filter(Boolean))].sort()
}

/**
 * The stack's own network, on the first free /24 of 100.100.0.0/16 (inside
 * Tailscale's 100.64.0.0/10). Making it claims the stack's name: null when a
 * stack of that name exists, which a parallel `up` may have made a moment ago.
 */
function createNetwork(stack) {
  for (let block = 1; block < 255; block += 1) {
    const made = spawnSync(
      'docker',
      [
        'network',
        'create',
        '--label',
        `${LABEL}=${stack}`,
        '--subnet',
        `100.100.${block}.0/24`,
        '--gateway',
        `100.100.${block}.1`,
        `${stack}-net`,
      ],
      { encoding: 'utf8' },
    )
    if (made.status === 0) return { name: `${stack}-net`, prefix: `100.100.${block}` }
    if (/already exists/iu.test(made.stderr)) return null
    if (!/overlap|in use/iu.test(made.stderr)) throw new Error(made.stderr.trim())
  }
  throw new Error('No free 100.100.x.0/24 network for the stack.')
}

/** A port free on this machine now, for a listener that must have the same port inside and out. */
function freePort() {
  return new Promise((done, fail) => {
    const server = createServer()
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => done(port))
    })
  })
}

/**
 * `docker run` with each container port published on a host port chosen here,
 * so the mapping is part of the container and survives `docker restart`: one
 * left to Docker (`127.0.0.1::9222`) is drawn again on every start, and a
 * restarted desktop was found on new ports. A port taken between the choice
 * and the run is chosen again.
 */
async function runPublishing(container, ports, args, options = {}) {
  for (let tries = 0; ; tries += 1) {
    const published = []
    for (const port of ports) published.push('-p', `127.0.0.1:${await freePort()}:${port}`)
    try {
      return docker([...args.slice(0, 2), ...published, ...args.slice(2)], options)
    } catch (error) {
      const message = String(error.stderr ?? error.message)
      if (tries >= 4 || !/port is already allocated|address already in use/iu.test(message)) throw error
      spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' })
    }
  }
}

function publishedPort(container, port) {
  const line = docker(['port', container, `${port}/tcp`]).split('\n')[0]
  return Number(line.slice(line.lastIndexOf(':') + 1))
}

async function waitForWindow(cdpPort, container) {
  const deadline = Date.now() + READY_MS
  while (Date.now() < deadline) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
      if (pages.some((page) => page.type === 'page' && page.url.includes('windowId=primary'))) return
    } catch {
      // Not listening yet.
    }
    if (!docker(['ps', '-q', '--filter', `name=^${container}$`])) {
      throw new Error(
        `${container} exited:\n${spawnSync('docker', ['logs', '--tail', '40', container], { encoding: 'utf8' }).stderr}`,
      )
    }
    await sleep(500)
  }
  throw new Error(`${container}: no window on its DevTools port in ${READY_MS / 1000} s`)
}

async function startDesktop(stack, network, name, ip, nodes, options) {
  const container = `${stack}-${name}`
  const env = {
    STUDIO_TAILNET_SELF: name,
    STUDIO_TAILNET_NODES: nodes,
    // Every Open Folder answers this folder (the app's own test hook, unpackaged builds only);
    // `open-dir` changes it in a running desktop.
    SPRINTENGINE_TEST_OPEN_DIR: '/data/projects/demo',
    ...(options.ssh ? { STUDIO_SSH_MACHINES: 'on' } : {}),
  }
  // Opt-in, for a real agent CLI a tester installs in the container; never set
  // by the harness. Named on the command line and handed over in `docker`'s
  // own environment, so a key never shows in a process list.
  const keys = {
    ...(process.env.STUDIO_DOCKER_ANTHROPIC_API_KEY
      ? { ANTHROPIC_API_KEY: process.env.STUDIO_DOCKER_ANTHROPIC_API_KEY }
      : {}),
    ...(process.env.STUDIO_DOCKER_OPENAI_API_KEY ? { OPENAI_API_KEY: process.env.STUDIO_DOCKER_OPENAI_API_KEY } : {}),
  }
  await runPublishing(
    container,
    [9222, 9230, 18471],
    [
      'run',
      '-d',
      '--init',
      '--name',
      container,
      '--hostname',
      name,
      '--label',
      `${LABEL}=${stack}`,
      '--network',
      network,
      '--ip',
      ip,
      '--cap-add',
      'NET_ADMIN',
      '--shm-size',
      '512m',
      '--memory',
      DESKTOP_MEMORY,
      '--cpus',
      DESKTOP_CPUS,
      ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
      ...Object.keys(keys).flatMap((key) => ['-e', key]),
      DESKTOP_IMAGE,
      '--inspect=127.0.0.1:9229',
    ],
    { env: { ...process.env, ...keys } },
  )
  return container
}

async function startSshMachine(stack, network, ip) {
  const container = `${stack}-build-box`
  await runPublishing(container, [22], [
    'run',
    '-d',
    '--init',
    '--name',
    container,
    '--hostname',
    'build-box',
    '--label',
    `${LABEL}=${stack}`,
    '--network',
    network,
    '--network-alias',
    'build-box',
    '--ip',
    ip,
    SSH_MACHINE_IMAGE,
  ])
  return container
}

/** The desktop's public key, admitted by the SSH machine's `dev`. */
async function admitKey(desktop, machine) {
  for (let tries = 0; tries < 60; tries += 1) {
    const key = spawnSync('docker', ['exec', '-u', 'tester', desktop, 'cat', '/home/tester/.ssh/id_ed25519.pub'], {
      encoding: 'utf8',
    })
    if (key.status === 0 && key.stdout.trim()) {
      docker(
        [
          'exec',
          '-i',
          machine,
          'sh',
          '-c',
          'umask 077; cat >> /home/dev/.ssh/authorized_keys && chown dev:dev /home/dev/.ssh/authorized_keys',
        ],
        { input: key.stdout },
      )
      return
    }
    await sleep(500)
  }
  throw new Error(`${desktop} made no SSH key`)
}

function startWebServer(stack, network, ip, port) {
  const container = `${stack}-server`
  docker([
    'run',
    '-d',
    '--init',
    '--name',
    container,
    '--hostname',
    'studio-server',
    '--label',
    `${LABEL}=${stack}`,
    '--network',
    network,
    '--ip',
    ip,
    '--memory',
    DESKTOP_MEMORY,
    '--cpus',
    DESKTOP_CPUS,
    '-p',
    `127.0.0.1:${port}:${port}`,
    '-e',
    'STUDIO_ROLE=web',
    '-e',
    `STUDIO_WEB_PORT=${port}`,
    DESKTOP_IMAGE,
  ])
  return container
}

async function waitForWeb(url, container) {
  const deadline = Date.now() + READY_MS
  while (Date.now() < deadline) {
    if ((await fetch(url).catch(() => null))?.ok) return
    if (!docker(['ps', '-q', '--filter', `name=^${container}$`]))
      throw new Error(
        `${container} exited:\n${spawnSync('docker', ['logs', '--tail', '40', container], { encoding: 'utf8' }).stdout}`,
      )
    await sleep(500)
  }
  throw new Error(`${container}: the web client did not answer in ${READY_MS / 1000} s`)
}

/** A one-time link that pairs a browser with the stack's server (it works once, within five minutes). */
function pairingLink(container) {
  return docker([
    'exec',
    '-u',
    'tester',
    container,
    'node',
    '/app/out/server/server.cjs',
    'pair',
    '--data-dir',
    '/data/server',
  ])
}

async function up(topologyName, options) {
  const topology = TOPOLOGIES[topologyName]
  if (!topology) throw new Error(`Unknown topology "${topologyName}": one of ${Object.keys(TOPOLOGIES).join(', ')}.`)
  if (!hasImage(DESKTOP_IMAGE) || (topology.ssh && !hasImage(SSH_MACHINE_IMAGE))) build()
  if (options.name && !/^[a-z0-9][a-z0-9-]{0,30}$/u.test(options.name))
    throw new Error('A stack name is lower-case letters, digits and dashes.')
  // The network claims the name; an automatic name moves on past one a parallel `up` took.
  let stack = options.name
  let network = stack ? createNetwork(stack) : null
  if (stack && !network) throw new Error(`A stack named ${stack} already exists.`)
  for (let n = 1; !network; n += 1) {
    stack = `${topologyName}-${n}`
    network = createNetwork(stack)
  }

  try {
    if (topology.web) {
      const port = await freePort()
      const container = startWebServer(stack, network.name, `${network.prefix}.10`, port)
      const web = `http://127.0.0.1:${port}`
      await waitForWeb(web, container)
      return {
        stack,
        topology: topologyName,
        desktops: [],
        sshMachine: null,
        server: { container, web, pairingLink: pairingLink(container) },
      }
    }
    const ips = Object.fromEntries(topology.desktops.map((name, index) => [name, `${network.prefix}.${11 + index}`]))
    const nodes = Object.entries(ips)
      .map(([name, ip]) => `${name}=${ip}`)
      .join(',')
    const desktops = []
    for (const name of topology.desktops) {
      desktops.push(await startDesktop(stack, network.name, name, ips[name], nodes, { ssh: topology.ssh }))
    }
    let machine = null
    if (topology.ssh) {
      machine = await startSshMachine(stack, network.name, `${network.prefix}.20`)
      await admitKey(desktops[0], machine)
    }
    const info = { stack, topology: topologyName, desktops: [], sshMachine: null }
    for (const [index, container] of desktops.entries()) {
      const cdp = publishedPort(container, 9222)
      await waitForWindow(cdp, container)
      const name = topology.desktops[index]
      info.desktops.push({
        name,
        container,
        cdp: `http://127.0.0.1:${cdp}`,
        server: `http://127.0.0.1:${publishedPort(container, 18471)}`,
        mainInspector: `127.0.0.1:${publishedPort(container, 9230)}`,
        tailnetAddress: `${ips[name]}:8471`,
      })
    }
    if (machine)
      info.sshMachine = {
        container: machine,
        fromDesktop: 'dev@build-box',
        password: 'devpass',
        fromHost: `ssh -p ${publishedPort(machine, 22)} dev@127.0.0.1`,
        project: '/home/dev/proj',
      }
    return info
  } catch (error) {
    say(`studio-docker: up failed (${error.message.split('\n')[0]}); removing stack ${stack}`)
    down([stack])
    throw error
  }
}

function printInfo(info) {
  console.log(`stack ${info.stack} (${TOPOLOGIES[info.topology].summary}) is up`)
  if (info.server) {
    console.log(`  server`)
    console.log(`    web client    ${info.server.web}`)
    console.log(
      `    pairing link  ${info.server.pairingLink}   (works once, within five minutes; \`pair ${info.stack}\` makes another)`,
    )
    console.log(`    shell         docker exec -it -u tester ${info.server.container} bash`)
  }
  for (const desktop of info.desktops) {
    console.log(`  ${desktop.name}`)
    console.log(`    CDP             ${desktop.cdp}`)
    console.log(
      `    server          ${desktop.server}   (Studio's tailnet listener; ${desktop.tailnetAddress} on the stack's tailnet)`,
    )
    console.log(`    main inspector  ${desktop.mainInspector}`)
    console.log(`    shell           docker exec -it -u tester ${desktop.container} bash`)
  }
  if (info.sshMachine) {
    console.log(`  build-box (SSH machine)`)
    console.log(
      `    from the desktop  ${info.sshMachine.fromDesktop} (key admitted; password ${info.sshMachine.password})`,
    )
    console.log(`    from this Mac     ${info.sshMachine.fromHost}`)
    console.log(`    project           ${info.sshMachine.project}`)
  }
  console.log(`  down: node tests/docker/studio-docker.mjs down ${info.stack}`)
}

// ── down, ls ─────────────────────────────────────────────────────────────

function down(names) {
  for (const stack of names) {
    const ids = docker(['ps', '-aq', '--filter', `label=${LABEL}=${stack}`])
      .split('\n')
      .filter(Boolean)
    if (ids.length) spawnSync('docker', ['rm', '-f', '-v', ...ids], { stdio: 'ignore' })
    const nets = docker(['network', 'ls', '-q', '--filter', `label=${LABEL}=${stack}`])
      .split('\n')
      .filter(Boolean)
    if (nets.length) spawnSync('docker', ['network', 'rm', ...nets], { stdio: 'ignore' })
    say(`studio-docker: ${stack} removed (${ids.length} container${ids.length === 1 ? '' : 's'})`)
  }
}

function envOf(container, key) {
  const env = JSON.parse(docker(['inspect', '-f', '{{json .Config.Env}}', container]))
  return env.find((entry) => entry.startsWith(`${key}=`))?.slice(key.length + 1)
}

function describe(stack) {
  const ids = docker(['ps', '-q', '--filter', `label=${LABEL}=${stack}`])
    .split('\n')
    .filter(Boolean)
  const info = { stack, desktops: [], sshMachine: null, server: null }
  for (const id of ids) {
    const name = docker(['inspect', '-f', '{{.Name}}', id]).replace(/^\//u, '')
    if (name === `${stack}-server`) {
      info.server = {
        container: name,
        web: `http://127.0.0.1:${publishedPort(name, Number(envOf(name, 'STUDIO_WEB_PORT')))}`,
      }
      continue
    }
    if (name.endsWith('-build-box')) {
      info.sshMachine = { container: name, fromHost: `ssh -p ${publishedPort(name, 22)} dev@127.0.0.1` }
      continue
    }
    info.desktops.push({
      name: name.slice(stack.length + 1),
      container: name,
      cdp: `http://127.0.0.1:${publishedPort(name, 9222)}`,
      server: `http://127.0.0.1:${publishedPort(name, 18471)}`,
      mainInspector: `127.0.0.1:${publishedPort(name, 9230)}`,
    })
  }
  info.desktops.sort((left, right) => left.name.localeCompare(right.name))
  return info
}

// ── open-dir ─────────────────────────────────────────────────────────────

/** Points the desktop's Open Folder at another folder, through its main process's inspector. */
async function openDir(stack, desktopName, path) {
  const desktop = describe(stack).desktops.find((each) => each.name === desktopName)
  if (!desktop) throw new Error(`No desktop ${desktopName} in ${stack}.`)
  const exists = spawnSync('docker', ['exec', '-u', 'tester', desktop.container, 'test', '-d', path]).status === 0
  if (!exists) throw new Error(`${path} is not a folder in ${desktop.container}.`)
  await evaluateInMain(desktop.mainInspector, `process.env.SPRINTENGINE_TEST_OPEN_DIR = ${JSON.stringify(path)}`)
  say(`studio-docker: Open Folder in ${desktop.container} now answers ${path}`)
}

async function evaluateInMain(inspector, expression) {
  const [target] = await (await fetch(`http://${inspector}/json/list`)).json()
  const socket = new WebSocket(target.webSocketDebuggerUrl.replace(/ws:\/\/[^/]+/u, `ws://${inspector}`))
  await new Promise((done, fail) => {
    socket.onopen = done
    socket.onerror = () => fail(new Error(`The main inspector at ${inspector} did not answer.`))
  })
  const answer = new Promise((done) => {
    socket.onmessage = (event) => done(JSON.parse(event.data))
  })
  socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
  const reply = await answer
  socket.close()
  if (reply.result?.exceptionDetails) throw new Error(reply.result.exceptionDetails.text)
  return reply.result?.result?.value
}

// ── main ─────────────────────────────────────────────────────────────────

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const flag = (name) => {
    const at = rest.indexOf(name)
    return at === -1 ? undefined : rest.splice(at, 2)[1]
  }
  switch (command) {
    case 'build':
      build()
      break
    case 'up': {
      const json = rest.includes('--json')
      const name = flag('--name')
      const info = await up(rest.filter((arg) => arg !== '--json')[0] ?? 'single', { name })
      if (json) console.log(JSON.stringify(info, null, 2))
      else printInfo(info)
      break
    }
    case 'ls':
      for (const stack of stacks()) console.log(JSON.stringify(describe(stack)))
      break
    case 'smoke': {
      const { smoke } = await import('./smoke.mjs')
      const info = describe(rest[0] ?? '')
      if (!info.desktops.length && !info.server) throw new Error(`Nothing is running in stack "${rest[0]}".`)
      await smoke(info, pairingLink)
      break
    }
    case 'pair': {
      const { server } = describe(rest[0] ?? '')
      if (!server) throw new Error(`Stack "${rest[0]}" has no web server (the web topology has one).`)
      console.log(pairingLink(server.container))
      break
    }
    case 'open-dir':
      await openDir(rest[0], rest[1], rest[2])
      break
    case 'down':
      down(rest.includes('--all') ? stacks() : rest)
      break
    default:
      console.log(
        'usage: node tests/docker/studio-docker.mjs build | up <single|ssh|paired|web> [--name <stack>] [--json] | ls | smoke <stack> | pair <stack> | open-dir <stack> <desktop> <path> | down <stack>... | down --all',
      )
      process.exitCode = command ? 1 : 0
  }
}

main().catch((error) => {
  console.error(`studio-docker: ${error.message}`)
  process.exitCode = 1
})
