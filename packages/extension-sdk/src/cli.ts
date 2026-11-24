#!/usr/bin/env node
// sprintengine-extension — packaging and signing CLI for SprintEngine Studio
// extension authors. Runs without repo access: everything it needs
// ships in the @sprintengine/extension-sdk tarball.
//
//   init             create an extension project from one of the templates
//   add              add a part (main, mcp, settings, door) to an extension project
//   keygen           generate an ed25519 signing keypair (private key PEM)
//   pack             validate an extension folder and assemble an installable copy
//   sign             write extension.sig, a detached ed25519 signature, beside extension.json
//   verify           check an extension folder the way the studio will
//   validate         check an extension folder (or its extension.json) as Studio will load it (--json)
//   inspect          what it contributes and the access it asks for (--json)
//   test             run its tests with its own Vitest or node --test, TS and JSX as written (--json)
//   check            validate, activate its worker, build each surface (--json)
//   dev              load a development folder into the running Studio, watch it,
//                    and drive its worker (--json)
//   shot             a PNG of one of its surfaces as Studio draws it (--json)
//   release-entry    the catalogue release entry for the committed HEAD (--json)
//
// sign records the sha256 of every file the extension ships, extension.json
// included, in extension.sig and signs those digests, so the signature covers
// the declaration and the code together; the app trusts an extension by its
// publisher key only when the folder matches them exactly.

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import {
  EXTENSION_MANIFEST_FILENAME,
  EXTENSION_SIGNATURE_FILENAME,
  EXTENSION_SURFACE_POINTS,
  parseExtensionManifest,
  type ExtensionManifest,
} from './extension-manifest.js'
import type { ThirdPartyManifestIssue } from './manifest-validate.js'
import { parseLanguageConfiguration, parseTextMateGrammar } from './content-syntaxes.js'
import { computeModuleFileDigestsSync, moduleFileDigestIssuesSync } from './module-files.js'
import {
  generateModuleSigningKeyPair,
  parseExtensionSignature,
  signExtensionFiles,
  verifyExtensionSignature,
  type ExtensionSignature,
} from './signing.js'

const USAGE = `sprintengine-extension — pack, sign, and verify SprintEngine Studio extensions

Usage:
  sprintengine-extension init <dir> --template <id> [--with <part,...>] [--id <module-id>] [--name <name>] [--sdk-tarball <file>] [--force]
  sprintengine-extension validate <dir|extension.json> [--json]
  sprintengine-extension release-entry [dir] [--json]
  sprintengine-extension inspect <dir> [--json]
  sprintengine-extension test [dir] [--json]
  sprintengine-extension check [dir] [--json]
  sprintengine-extension dev load <dir> [--json]
  sprintengine-extension dev reload [<dir|key>] [--json]
  sprintengine-extension dev watch <dir> [--check] [--shot <out-dir> [--shot-panel <id>]] [--json]
  sprintengine-extension dev unload <dir|key> [--json]
  sprintengine-extension dev list [--json]
  sprintengine-extension dev logs <dir|key> [--json]
  sprintengine-extension dev request <dir|key> <method> [--data <json>] [--read] [--timeout-ms <ms>] [--json]
  sprintengine-extension dev hook <dir|key> <point> --data <json> [--json]
  sprintengine-extension dev emit <dir|key> <topic> [--data <json>] [--json]
  sprintengine-extension dev emit <dir|key> <event> --studio --data <json> [--json]
  sprintengine-extension list [--json]
  sprintengine-extension logs <key|dir> [--after <seq>] [--json]
  sprintengine-extension shot <dir|key> [--panel <id> | --door <id> | --settings <id>] [--theme light|dark] [--width <px>] [--height <px>] [--out <file.png>] [--json]
  sprintengine-extension add <part>... [--project <dir>] [--force]
  sprintengine-extension keygen [--out <file>] [--force]
  sprintengine-extension pack <extension-dir> [--out <dir>] [--force]
  sprintengine-extension sign <extension-dir> --key <private-key.pem>
  sprintengine-extension verify <extension-dir>

init creates an extension project in <dir> from a template: the extension, its
build and dev-loop scripts, and the agent instructions that send whichever agent
works on it to the extension guide. --id defaults to the folder name, --name to the id title-cased;
--sdk-tarball depends on a local SDK tarball instead of the npm release. Run it
with an unknown --template to list the templates. --with adds parts on top of
the template, as add does.

add puts a part into an existing project (--project, default the current
folder): main (src/main.ts, the worker, and its build), mcp (MCP tools served
by the worker), settings (a Settings section), door (a full-page surface). It
copies the part's files and test, merges what it contributes, its permissions
and the tier it needs into extension/extension.json, adds its build script,
and wires a worker part into src/main.ts. A part that needs the worker brings
it too. Run it with no part to list them.

validate, inspect, test and check work on an extension folder (the one
holding extension.json; a project's extension/ is found from the project)
without Studio. With --json each prints one object, {ok, result} or {ok:false,
error:{code, message, data?, nextSteps?}}: branch on error.code. Exit codes: 0
ok, 1 an error, 2 the extension is invalid (extension_invalid), 3 it needs
approval (approval_required); test exits with the runner's
code. validate takes the folder or its extension.json, and checks its skill
folders and the host calls its code writes out (an unknown studio.host.call
method, one its permissions or tier cannot use) at their file and line. test
runs every *.test.ts, .tsx, .mts, .js, .jsx and .mjs with the project's own
Vitest when it has one installed, else node --test; TypeScript and JSX load
as Studio loads them. test and check run the extension's code on this machine, outside
Studio: only on code you trust. release-entry prints the release entry a
catalogue lists for the committed HEAD of the repository holding the folder:
its commit, the content hash Studio checks at install, its tier, the Studio it
needs, its permissions and its contributions; and the folder's path in the
repository when it is not the root. Uncommitted changes are not in it.

dev and shot drive the SprintEngine Studio running on this machine (found in
its data folder; --data-dir names another). dev load registers the folder as
a development folder: Studio loads it from where it is, with no build, and
again on every save. Nothing in it runs until the person approves it in
Studio's window, which asks them as soon as it is registered (also Settings >
Extensions); nothing on the command line approves, so an agent can register a
folder but never approve one. One whose key an installed extension has
replaces it only once approved; the installed one runs until then. dev load
exits 3 (approval_required) while it waits. dev watch loads it, prints
"waiting for approval in Studio" and waits, then prints what happens:
reloaded, log lines (errors at file:line:col), status, approval, and with
--check a check (the folder offline, and how Studio runs it now), with --shot
a fresh PNG, after each save. Ctrl-C removes the folder again if the watch
added it. dev reload reads one development folder, or every one, again now.
dev request, hook, emit and shot reach development folders only. list and
logs cover installed extensions too.

keygen writes an ed25519 private key (PKCS#8 PEM) to --out
(default module-signing.key); a leading ~ is your home folder, on Windows too.
Keep it out of the extension's folder and out of version control; sign derives
the public key from it.

pack validates <extension-dir>/extension.json, checks that every file it names
is there, and copies the extension into --out (default packed/<id>) as an
installable folder. node_modules, .git, .sprintengine (the dev loop's shots),
key files (*.key, *.pem) and symbolic links are never copied.

sign validates extension.json, records the sha256 of every file the extension
ships (everything pack copies, extension.json included) in extension.sig, and
signs those digests with --key. Sign again after any change to its files.

verify validates extension.json, checks extension.sig's signature, and checks
that the files pack would copy are exactly the ones it lists, byte for byte:
exit 0 with the signer fingerprint when all of that holds, exit 1 when the
extension is unsigned or was changed after signing.`

function fail(message: string, issues?: ThirdPartyManifestIssue[]): never {
  console.error(message)
  for (const issue of issues ?? []) {
    console.error(`  - ${issue.path === '' ? 'manifest' : issue.path}: ${issue.message}`)
  }
  process.exit(1)
}

function readManifest(extensionDir: string): { manifestPath: string; manifest: ExtensionManifest } {
  const manifestPath = join(extensionDir, EXTENSION_MANIFEST_FILENAME)
  if (!existsSync(manifestPath)) {
    fail(`No ${EXTENSION_MANIFEST_FILENAME} in ${extensionDir}.`)
  }
  // The author's check: engines.studio must cover every field the manifest uses.
  const result = parseExtensionManifest(readFileSync(manifestPath, 'utf8'), { authoring: true })
  if (!result.ok) {
    fail(`Invalid extension manifest at ${manifestPath}:`, result.issues)
  }
  return { manifestPath, manifest: result.manifest }
}

/** Every file extension.json names: the worker, each surface's entry, the images. */
function declaredFiles(manifest: ExtensionManifest): Array<{ path: string; file: string }> {
  const files: Array<{ path: string; file: string }> = []
  if (manifest.main) files.push({ path: 'main', file: manifest.main })
  for (const point of EXTENSION_SURFACE_POINTS) {
    manifest.contributes[point].forEach((surface, index) =>
      files.push({ path: `contributes.${point}[${index}].entry`, file: surface.entry }),
    )
  }
  manifest.contributes.syntaxes.forEach((syntax, index) => {
    files.push({ path: `contributes.syntaxes[${index}].path`, file: syntax.path })
    if (syntax.configuration)
      files.push({ path: `contributes.syntaxes[${index}].configuration`, file: syntax.configuration })
  })
  if (manifest.icon) files.push({ path: 'icon', file: manifest.icon })
  if (manifest.cover) files.push({ path: 'cover', file: manifest.cover })
  manifest.screenshots?.forEach((file, index) => files.push({ path: `screenshots[${index}]`, file }))
  return files
}

function readSignature(extensionDir: string): ExtensionSignature | null {
  const path = join(extensionDir, EXTENSION_SIGNATURE_FILENAME)
  if (!existsSync(path)) return null
  const parsed = parseExtensionSignature(readFileSync(path, 'utf8'))
  if (!parsed.ok) fail(`${path}: ${parsed.message}`)
  return parsed.signature
}

function displayNameFromId(id: string): string {
  return id
    .split('-')
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ')
}

function isInsideOrEqual(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

// A leading `~` is the home folder. The templates' `keygen` script quotes it,
// so no shell expands it: npm runs scripts in cmd.exe on Windows, which
// expands neither `~` nor `$HOME`.
function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') || path.startsWith('~\\') ? join(homedir(), path.slice(1)) : path
}

function keygen(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: { out: { type: 'string' }, force: { type: 'boolean' } },
  })
  const outPath = resolve(expandHome(values.out ?? 'module-signing.key'))
  if (existsSync(outPath) && !values.force) {
    fail(`${outPath} already exists. Pass --force to overwrite it.`)
  }
  const keyPair = generateModuleSigningKeyPair()
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, keyPair.privateKeyPem, { mode: 0o600 })
  console.log(`Wrote ed25519 private key to ${outPath}`)
  console.log(`Public key fingerprint: ${keyPair.fingerprint}`)
  console.log("Keep this key out of the extension's folder and out of version control.")
}

function pack(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: { out: { type: 'string' }, force: { type: 'boolean' } },
    allowPositionals: true,
  })
  const extensionDir = positionals[0]
  if (!extensionDir) fail(`pack requires an extension folder.\n\n${USAGE}`)
  const sourceDir = resolve(extensionDir)
  const { manifest } = readManifest(sourceDir)

  const missing: ThirdPartyManifestIssue[] = declaredFiles(manifest)
    .filter(({ file }) => !existsSync(join(sourceDir, file)))
    .map(({ path, file }) => ({ path, message: `names "${file}", which does not exist.` }))
  if (missing.length > 0) fail(`Files extension.json names are missing in ${sourceDir}:`, missing)
  // Content is checked as Studio checks it at install and when it serves it.
  const content: ThirdPartyManifestIssue[] = []
  manifest.contributes.syntaxes.forEach((syntax, index) => {
    const grammar = parseTextMateGrammar(readFileSync(join(sourceDir, syntax.path), 'utf8'), syntax.scopeName)
    if (!grammar.ok)
      content.push(
        ...grammar.issues.map((issue) => ({
          path: `contributes.syntaxes[${index}].path`,
          message: `${syntax.path}${issue.path ? ` (${issue.path})` : ''}: ${issue.message}`,
        })),
      )
    if (!syntax.configuration) return
    const configuration = parseLanguageConfiguration(readFileSync(join(sourceDir, syntax.configuration), 'utf8'))
    if (!configuration.ok)
      content.push(
        ...configuration.issues.map((issue) => ({
          path: `contributes.syntaxes[${index}].configuration`,
          message: `${syntax.configuration}${issue.path ? ` (${issue.path})` : ''}: ${issue.message}`,
        })),
      )
  })
  if (content.length > 0) fail(`Content files in ${sourceDir} are not ones Studio can use:`, content)

  // A pack whose files no longer match the signed digests would install as
  // tampered; say so here, where signing again is one command away.
  const signature = readSignature(sourceDir)
  if (signature) {
    const drift = moduleFileDigestIssuesSync(sourceDir, signature.files, { walk: 'pack' })
    if (drift.length > 0) {
      fail(`Files changed after signing in ${sourceDir}; run \`sprintengine-extension sign\` again:`, drift)
    }
  }

  const outDir = resolve(values.out ?? join('packed', manifest.id))
  if (existsSync(outDir) && !values.force) {
    fail(`${outDir} already exists. Pass --force to overwrite it.`)
  }
  if (isInsideOrEqual(sourceDir, outDir)) {
    fail('The pack output directory must be outside the extension folder.')
  }

  const skipped: string[] = []
  cpSync(sourceDir, outDir, {
    recursive: true,
    force: true,
    verbatimSymlinks: true,
    filter: (src) => {
      const name = basename(src)
      // The dev loop's own folder (its shots) never ships, as node_modules and .git never do.
      if (name === 'node_modules' || name === '.git' || name === '.sprintengine') return false
      if (lstatSync(src).isSymbolicLink()) {
        skipped.push(`${relative(sourceDir, src)} (a symbolic link)`)
        return false
      }
      if (name.endsWith('.key') || name.endsWith('.pem')) {
        skipped.push(`${name} (key material)`)
        return false
      }
      return true
    },
  })
  for (const name of skipped) console.warn(`Skipped ${name}: never packed into an extension.`)
  const signedNote = signature ? 'signed' : 'UNSIGNED — run `sprintengine-extension sign` before distributing'
  console.log(`Packed ${manifest.id} ${manifest.version} (${signedNote}) to ${outDir}`)
}

function signCommand(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: { key: { type: 'string' } },
    allowPositionals: true,
  })
  const extensionDir = positionals[0]
  if (!extensionDir) fail(`sign requires an extension folder.\n\n${USAGE}`)
  if (!values.key) fail('sign requires --key <private-key.pem> (create one with `sprintengine-extension keygen`).')
  const keyPath = resolve(expandHome(values.key))
  if (!existsSync(keyPath)) fail(`Signing key not found: ${keyPath}`)

  const root = resolve(extensionDir)
  const { manifest } = readManifest(root)
  // The pack view: node_modules, .git and key files are left out here exactly
  // as pack leaves them out, so the packed copy matches what was signed.
  const digests = computeModuleFileDigestsSync(root, { walk: 'pack' })
  if (!digests.ok) fail(`Files in ${root} cannot be signed:`, digests.issues)
  const missing: ThirdPartyManifestIssue[] = declaredFiles(manifest)
    .filter(({ file }) => digests.files[file] === undefined)
    .map(({ path, file }) => ({ path, message: `names "${file}", which is not in the extension.` }))
  if (missing.length > 0) fail(`Files extension.json names are missing in ${root}:`, missing)
  let signature: ExtensionSignature
  try {
    signature = signExtensionFiles(digests.files, readFileSync(keyPath, 'utf8'))
  } catch (error) {
    fail(`Could not sign with ${keyPath}: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
  const signaturePath = join(root, EXTENSION_SIGNATURE_FILENAME)
  writeFileSync(signaturePath, JSON.stringify(signature, null, 2) + '\n')
  const { fingerprint } = verifyExtensionSignature(signature)
  console.log(`Signed ${manifest.id} and ${Object.keys(digests.files).length} file(s); wrote ${signaturePath}`)
  console.log(`Signer fingerprint: ${fingerprint}`)
}

function verifyCommand(args: string[]): void {
  const { positionals } = parseArgs({ args, allowPositionals: true })
  const extensionDir = positionals[0]
  if (!extensionDir) fail(`verify requires an extension folder.\n\n${USAGE}`)
  const root = resolve(extensionDir)
  const { manifest } = readManifest(root)
  const signature = readSignature(root)
  if (!signature) {
    fail(
      `${manifest.id} is unsigned. The app will show it as 'unsigned'; sign it with \`sprintengine-extension sign\`.`,
    )
  }
  const { valid, fingerprint } = verifyExtensionSignature(signature)
  if (!valid) {
    fail(
      `${manifest.id} has an INVALID signature (extension.sig changed after signing, or wrong key). ` +
        'The app will refuse to run it. Sign it again.',
    )
  }
  const drift = moduleFileDigestIssuesSync(root, signature.files, { walk: 'pack', label: 'signed digests' })
  if (drift.length > 0) {
    fail(
      `${manifest.id} does not match the file digests extension.sig signs (changed after signing?). ` +
        'The app will refuse it as tampered. Sign it again with `sprintengine-extension sign`.',
      drift,
    )
  }
  console.log(`${manifest.id}: signature valid; ${Object.keys(signature.files).length} file(s) match`)
  console.log(`Signer fingerprint: ${fingerprint}`)
}

async function init(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      template: { type: 'string' },
      id: { type: 'string' },
      name: { type: 'string' },
      'sdk-tarball': { type: 'string' },
      with: { type: 'string', multiple: true },
      force: { type: 'boolean' },
    },
    allowPositionals: true,
  })
  const { listModuleTemplates, scaffoldModuleProject, sdkPackageVersion } = await import('./scaffold.js')
  const parts = (values.with ?? [])
    .flatMap((value) => value.split(','))
    .map((part) => part.trim())
    .filter(Boolean)
  const templates = (): string =>
    listModuleTemplates()
      .map((template) => `  ${template.id.padEnd(20)} ${template.summary}`)
      .join('\n')
  const dir = positionals[0]
  if (!dir) fail(`init requires a project directory.\n\n${USAGE}`)
  if (!values.template) fail(`init requires --template <id>. The templates:\n${templates()}`)
  const target = resolve(dir)
  const id =
    values.id ??
    basename(target)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
  const tarball = values['sdk-tarball'] ? resolve(values['sdk-tarball']) : undefined
  if (tarball && !existsSync(tarball)) fail(`SDK tarball not found: ${tarball}`)
  const result = await scaffoldModuleProject({
    dir: target,
    templateId: values.template,
    id,
    displayName: values.name ?? displayNameFromId(id),
    sdkVersion: sdkPackageVersion(),
    ...(tarball ? { sdkTarballPath: tarball } : {}),
    ...(values.force ? { force: true } : {}),
    ...(parts.length > 0 ? { parts } : {}),
  })
  if (!result.ok) {
    fail(result.code === 'unknown_template' ? `${result.message}\n\n${templates()}` : result.message)
  }
  const withParts = parts.length > 0 ? ` with ${parts.join(', ')}` : ''
  console.log(
    `Created ${id} from the ${values.template} template${withParts} in ${target} (${result.files.length} files).`,
  )
  for (const note of result.notes ?? []) console.log(`To do: ${note}`)
  console.log('Next: npm install, then npm run dev: Studio loads it from where it is and again on every save.')
}

async function add(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: { project: { type: 'string' }, force: { type: 'boolean' } },
    allowPositionals: true,
  })
  const { addModuleParts, listModuleParts } = await import('./scaffold.js')
  const parts = (): string =>
    listModuleParts()
      .map((part) => `  ${part.id.padEnd(12)} ${part.summary}`)
      .join('\n')
  const requested = positionals
    .flatMap((value) => value.split(','))
    .map((part) => part.trim())
    .filter(Boolean)
  if (requested.length === 0) fail(`add requires a part. The parts:\n${parts()}`)
  const dir = resolve(values.project ?? '.')
  const result = await addModuleParts({ dir, parts: requested, ...(values.force ? { force: true } : {}) })
  if (!result.ok) fail(result.code === 'unknown_part' ? `${result.message}\n\n${parts()}` : result.message)
  console.log(`Added ${result.added.join(', ')} to ${dir}:`)
  for (const file of result.files) console.log(`  ${file}`)
  for (const note of result.notes) console.log(`To do: ${note}`)
  console.log('Next: npm install (a part may add dependencies), then npm run check.')
}

const [command, ...rest] = process.argv.slice(2)
const authoring = new Set(['validate', 'inspect', 'test', 'check', 'dev', 'shot', 'list', 'logs', 'release-entry'])
if (command && authoring.has(command)) {
  import('./cli-commands.js')
    .then(({ runAuthoringCommand }) => runAuthoringCommand(command, rest))
    .catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)))
} else
  switch (command) {
    case 'init':
      init(rest).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)))
      break
    case 'add':
      add(rest).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)))
      break
    case 'keygen':
      keygen(rest)
      break
    case 'pack':
      pack(rest)
      break
    case 'sign':
      signCommand(rest)
      break
    case 'verify':
      verifyCommand(rest)
      break
    case undefined:
    case '--help':
    case '-h':
      console.log(USAGE)
      break
    default:
      fail(`Unknown command "${command}".\n\n${USAGE}`)
  }
