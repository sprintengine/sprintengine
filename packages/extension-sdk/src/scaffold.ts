// Scaffold a new extension project from one of the templates this package
// ships (`templates/<id>/`).
//
// Subpath export `@sprintengine/extension-sdk/scaffold`. Node-only (it reads and
// writes the file system), so it is kept out of the root index, which must
// stay loadable in a renderer. The `sprintengine-extension init` command and the
// app's "Build your own extension" flow both call it, so a project made from
// the command line and one made from the app are the same project.
//
// A template is a folder holding `template.json` (what the picker shows) and
// the project files, among them `extension/extension.json` and its source in
// `extension/src/`, which Studio loads as written: there is no build step.
// `templates/_shared/` holds the files every project gets — package.json with
// the dev loop's scripts, tsconfig.json, the agent instructions — and a
// template's own file of the same path wins over the shared one. Text files carry `{{placeholder}}` tokens (see
// `placeholderValues`), and a file named `gitignore` is written as
// `.gitignore`: npm drops dot-gitignore files from a published tarball, so the
// template cannot ship one under its real name.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  EXTENSION_MANIFEST_FIELDS,
  EXTENSION_MANIFEST_SINCE,
  isReservedExtensionId,
  requiredExtensionTier,
  validateExtensionManifest,
  type ExtensionContributions,
  type ExtensionTier,
} from './extension-manifest.js'
import { EXTENSION_TIERS, tierRank } from './manifest-schema.js'
import type { ExtensionPermission } from './permissions.js'

export type ModuleTemplateInfo = {
  id: string
  title: string
  summary: string
  /** The permissions the template's extension.json declares, as the consent prompt will show them. */
  permissions: string[]
  /** What the template contributes or relies on (e.g. 'panel', 'worker'), for a picker's tags. */
  capabilities: string[]
}

export type ScaffoldModuleOptions = {
  /** The project folder. Created when missing; must be empty unless `force`. */
  dir: string
  templateId: string
  /** The extension id: kebab-case, and not one Studio keeps for its own (`studio-…`, `sprintengine-…`). */
  id: string
  /**
   * The name people see. Quotes, backslashes, braces, angle brackets, `$` and
   * backticks are dropped and an apostrophe becomes a typographic one (see
   * `sanitizeDisplayText`); it is cut to 64 characters, and an empty result
   * falls back to the id, title-cased.
   */
  displayName: string
  /** The SDK version the project depends on, as `^<sdkVersion>`. */
  sdkVersion: string
  /** A local SDK tarball to depend on instead of the npm release; copied into the project's `vendor/`. */
  sdkTarballPath?: string
  /** Defaults to the `templates/` folder beside this package's `dist/`. */
  templatesRoot?: string
  /** Written as the project's IDEA.md in place of the template's placeholder brief. */
  ideaMarkdown?: string
  /** Scaffold into a folder that already has files in it, overwriting the ones the template writes. */
  force?: boolean
  /**
   * Parts to add on top of the template (`listModuleParts`): `main`, `mcp`,
   * `settings`, `door`. The same as running `sprintengine-extension add` on the
   * new project.
   */
  parts?: readonly string[]
}

export type ScaffoldModuleResult =
  | {
      ok: true
      files: string[]
      /** Steps left to do by hand, when a part could not wire itself in. */
      notes?: string[]
    }
  | {
      ok: false
      code: 'unknown_template' | 'invalid_id' | 'dir_not_empty' | 'io_error' | 'unknown_part' | 'already_present'
      message: string
    }

const SHARED_TEMPLATE_DIR = '_shared'
const TEMPLATE_MANIFEST = 'template.json'
const SDK_PACKAGE = '@sprintengine/extension-sdk'
/** Where a project keeps its manifest: `extension/` is the folder Studio installs. */
const MANIFEST_PATH = 'extension/extension.json'
const MAX_DISPLAY_NAME = 64

// The id rule extension.json holds an id to, so a scaffolded project's
// manifest validates the moment it is written.
const EXTENSION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

// The picker order: the smallest starting point first, then the surfaces a
// person is most likely to be asking for. A template missing here sorts after
// these.
const TEMPLATE_ORDER = [
  'blank',
  'panel',
  'door',
  'editor',
  'chat-companion',
  'top-bar-item',
  'settings-section',
  'backlog-action',
  'file-action',
  'mcp-tools',
  'hook-guard',
  'agent-kit',
]

// dist/scaffold.js (published) and src/scaffold.ts (in the repository) both sit
// one level below the package root, so one relative step finds the folders.
// Worked out when asked, not when the module loads: an app that bundles this
// file into CommonJS (Studio's server) has no `import.meta.url`, and always
// passes the templates it ships instead.
function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

export function defaultTemplatesRoot(): string {
  return join(packageRoot(), 'templates')
}

/** This package's own version: what a project scaffolded by its CLI depends on. */
export function sdkPackageVersion(): string {
  const pkg = JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')) as { version?: unknown }
  if (typeof pkg.version !== 'string' || pkg.version === '') {
    throw new Error(`${join(packageRoot(), 'package.json')} carries no version.`)
  }
  return pkg.version
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0)
}

function readTemplateInfo(templateDir: string): ModuleTemplateInfo {
  const path = join(templateDir, TEMPLATE_MANIFEST)
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const { id, title, summary, permissions, capabilities } = value
  if (
    typeof id !== 'string' ||
    id !== basename(templateDir) ||
    typeof title !== 'string' ||
    typeof summary !== 'string' ||
    !Array.isArray(permissions) ||
    !permissions.every((entry) => typeof entry === 'string') ||
    !isStringArray(capabilities)
  ) {
    // A template ships inside this package; a malformed one is a packaging bug,
    // so it fails loudly rather than disappearing from the picker.
    throw new Error(
      `${path} must be { id (the folder name), title, summary, permissions: string[], capabilities: string[] }.`,
    )
  }
  return { id, title, summary, permissions: [...(permissions as string[])], capabilities: [...capabilities] }
}

function templateDirs(templatesRoot: string): string[] {
  return readdirSync(templatesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.'))
    .map((entry) => join(templatesRoot, entry.name))
    .filter((dir) => existsSync(join(dir, TEMPLATE_MANIFEST)))
}

function templateRank(id: string): number {
  const index = TEMPLATE_ORDER.indexOf(id)
  return index === -1 ? TEMPLATE_ORDER.length : index
}

/** Every template under `templatesRoot`, in picker order. */
export function listModuleTemplates(templatesRoot: string = defaultTemplatesRoot()): ModuleTemplateInfo[] {
  return templateDirs(templatesRoot)
    .map(readTemplateInfo)
    .sort((a, b) => templateRank(a.id) - templateRank(b.id) || a.id.localeCompare(b.id))
}

/** Every file under `dir`, as POSIX paths relative to it. */
function walkFiles(dir: string, prefix = ''): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...walkFiles(join(dir, entry.name), relativePath))
    else if (entry.isFile()) files.push(relativePath)
  }
  return files
}

/** The name a template file is written under in the project. */
function projectPath(templatePath: string): string {
  const segments = templatePath.split('/')
  if (segments[segments.length - 1] === 'gitignore') segments[segments.length - 1] = '.gitignore'
  return segments.join('/')
}

function displayNameFromId(id: string): string {
  return id
    .split('-')
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(' ')
}

// A name lands in JSON strings, TS string and template literals, JSX text and
// attributes, CSS comments and Markdown. Rather than escape it five ways, keep
// it to characters that are literal in all of them: an apostrophe becomes a
// typographic one, and quotes, backslashes, braces, angle brackets, `$`,
// backticks and control characters are dropped.
export function sanitizeDisplayText(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/'/g, '’')
    .replace(/["`\\{}<>$\u0000-\u001f\u007f]/g, '')
    .trim()
}

/** A display name extension.json takes: sanitized and at most 64 characters, else the id title-cased. */
function displayNameFor(name: string, id: string): string {
  return sanitizeDisplayText(name).slice(0, MAX_DISPLAY_NAME).trim() || displayNameFromId(id).slice(0, MAX_DISPLAY_NAME)
}

/**
 * What an extension's MCP tool names start with: its id with underscores, as
 * tool names take only lower-case letters, digits and underscores, starting
 * with a letter. Kept short enough that a tool's own name fits after it.
 */
function mcpToolPrefix(id: string): string {
  const base = id.replace(/-/g, '_').slice(0, 40).replace(/_+$/, '')
  return /^[a-z]/.test(base) ? base : `ext_${base}`
}

function placeholderValues(options: ScaffoldModuleOptions, template: ModuleTemplateInfo): Record<string, string> {
  return {
    id: options.id,
    displayName: displayNameFor(options.displayName, options.id),
    sdkVersion: options.sdkVersion,
    studioVersion: EXTENSION_MANIFEST_SINCE,
    templateId: template.id,
    templateTitle: sanitizeDisplayText(template.title),
    toolPrefix: mcpToolPrefix(options.id),
  }
}

function fillPlaceholders(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (token, name: string) => values[name] ?? token)
}

function isEmptyDir(dir: string): boolean {
  return readdirSync(dir).length === 0
}

/** Why an id cannot be an extension's, or null when it can. */
function extensionIdProblem(id: string): string | null {
  if (!EXTENSION_ID_PATTERN.test(id) || id.length > 63 || id === 'constructor' || id === 'prototype') {
    return `"${id}" is not an extension id: use lowercase letters and digits, in words joined by single hyphens (1–63 characters).`
  }
  if (isReservedExtensionId(id)) {
    return `"${id}" is kept for Studio’s own extensions (ids starting studio- or sprintengine-); choose another id.`
  }
  return null
}

/**
 * Create an extension project in `options.dir` from a template: the template's
 * files with the extension id, name and SDK version filled in, and the shared
 * dev-loop files. Expected failures come back as a result, never a throw.
 */
export async function scaffoldModuleProject(options: ScaffoldModuleOptions): Promise<ScaffoldModuleResult> {
  const idProblem = extensionIdProblem(options.id)
  if (idProblem) return { ok: false, code: 'invalid_id', message: idProblem }

  const templatesRoot = resolve(options.templatesRoot ?? defaultTemplatesRoot())
  const templateDir = join(templatesRoot, options.templateId)
  if (
    options.templateId.startsWith('_') ||
    options.templateId.includes('/') ||
    !existsSync(join(templateDir, TEMPLATE_MANIFEST))
  ) {
    let known: string[] = []
    try {
      known = listModuleTemplates(templatesRoot).map((template) => template.id)
    } catch {
      // The listing is only for the message; the unknown id is the failure.
    }
    return {
      ok: false,
      code: 'unknown_template',
      message: `There is no "${options.templateId}" template${known.length > 0 ? `; the templates are ${known.join(', ')}` : ''}.`,
    }
  }

  // Parts are checked against the template before anything is written, so a
  // part the template already has fails the scaffold rather than leaving half
  // a project behind.
  if (options.parts && options.parts.length > 0) {
    try {
      const templateManifest = JSON.parse(readFileSync(join(templateDir, MANIFEST_PATH), 'utf8')) as RawManifest
      const planned = planParts(join(templatesRoot, PARTS_DIR), options.parts, templateManifest)
      if (!planned.ok) return planned
    } catch (error) {
      return { ok: false, code: 'io_error', message: error instanceof Error ? error.message : String(error) }
    }
  }

  const dir = resolve(options.dir)
  try {
    if (existsSync(dir)) {
      if (!statSync(dir).isDirectory()) {
        return { ok: false, code: 'dir_not_empty', message: `${dir} exists and is not a folder.` }
      }
      if (!options.force && !isEmptyDir(dir)) {
        return {
          ok: false,
          code: 'dir_not_empty',
          message: `${dir} already has files in it. Choose an empty folder, or scaffold with force to write over them.`,
        }
      }
    }

    const template = readTemplateInfo(templateDir)
    const values = placeholderValues(options, template)
    // Shared first, template second: a template's file of the same path wins.
    const sources = new Map<string, string>()
    const sharedDir = join(templatesRoot, SHARED_TEMPLATE_DIR)
    if (existsSync(sharedDir)) {
      for (const path of walkFiles(sharedDir)) sources.set(projectPath(path), join(sharedDir, path))
    }
    for (const path of walkFiles(templateDir)) {
      if (path === TEMPLATE_MANIFEST) continue
      sources.set(projectPath(path), join(templateDir, path))
    }

    const written: string[] = []
    const write = (relativePath: string, content: string | Buffer): void => {
      const target = join(dir, relativePath)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content)
      written.push(relativePath)
    }

    for (const [relativePath, source] of sources) {
      if (relativePath === 'IDEA.md' && options.ideaMarkdown !== undefined) {
        write(relativePath, options.ideaMarkdown.endsWith('\n') ? options.ideaMarkdown : `${options.ideaMarkdown}\n`)
        continue
      }
      let text = fillPlaceholders(readFileSync(source, 'utf8'), values)
      if (relativePath === 'package.json' && options.sdkTarballPath) {
        text = dependOnTarball(text, `file:vendor/${basename(options.sdkTarballPath)}`)
      }
      write(relativePath, text)
    }

    if (options.sdkTarballPath) {
      const tarball = resolve(options.sdkTarballPath)
      const target = `vendor/${basename(tarball)}`
      mkdirSync(join(dir, 'vendor'), { recursive: true })
      copyFileSync(tarball, join(dir, target))
      written.push(target)
    }

    if (options.parts && options.parts.length > 0) {
      const added = await addModuleParts({ dir, parts: options.parts, templatesRoot, force: options.force })
      // The parts were planned against the template before anything was
      // written, so what is left to fail here is the file system.
      if (!added.ok) {
        return {
          ok: false,
          code: added.code === 'unknown_part' || added.code === 'already_present' ? added.code : 'io_error',
          message: added.message,
        }
      }
      return {
        ok: true,
        files: [...new Set([...written, ...added.files])].sort(),
        ...(added.notes.length > 0 ? { notes: added.notes } : {}),
      }
    }
    return { ok: true, files: written.sort() }
  } catch (error) {
    return {
      ok: false,
      code: 'io_error',
      message: `Could not scaffold into ${dir}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

function dependOnTarball(packageJson: string, spec: string): string {
  const pkg = JSON.parse(packageJson) as { devDependencies?: Record<string, string> }
  pkg.devDependencies = { ...pkg.devDependencies, [SDK_PACKAGE]: spec }
  return `${JSON.stringify(pkg, null, 2)}\n`
}

// ── Parts: what `init --with` and `sprintengine-extension add` put in a project ──
//
// A part is a folder under `templates/_parts/<id>/` holding `part.json` and
// the files it adds (placeholders as in a template). Adding one copies its
// files, merges its contributions, permissions and `main` into
// extension/extension.json and raises `tier` to what the result needs, adds
// any scripts and devDependencies it names to package.json, and wires its
// registration into the worker by inserting an import and a call at the top
// of `activate` in the worker's source (`main`, under extension/). A part that
// needs the worker brings it first (`main`).
//
// Nothing else composes: Studio loads each surface and the worker from source,
// so adding a door is adding its file and its contribution.

const PARTS_DIR = '_parts'
const PART_MANIFEST = 'part.json'
// The order parts are listed and applied in.
const PART_ORDER = ['main', 'mcp', 'settings', 'door']
/** Where the extension's files are, in the project: `main` and every `entry` are relative to it. */
const EXTENSION_DIR = 'extension'
const CONTRIBUTION_POINTS = Object.keys(
  (EXTENSION_MANIFEST_FIELDS.fields.contributes!.node as { fields: Record<string, unknown> }).fields,
)

type ContributionPoint = keyof ExtensionContributions
type RawManifest = Record<string, unknown> & {
  id?: unknown
  name?: unknown
  tier?: unknown
  main?: unknown
  permissions?: unknown
  contributes?: Record<string, unknown>
}

export type ModulePartInfo = {
  id: string
  title: string
  summary: string
  /** The parts it needs (`main`); added first when the project lacks them. */
  requires: string[]
  /** The permissions it adds to extension.json. */
  permissions: string[]
}

type PartDefinition = ModulePartInfo & {
  /** The worker entry it adds (`main` only). */
  main?: string
  contributes: Partial<Record<ContributionPoint, Array<Record<string, unknown>>>>
  scripts: Record<string, string>
  devDependencies: Record<string, string>
  register?: { import: string; call: string }
  dir: string
}

export type ModulePartsFailureCode =
  'unknown_part' | 'already_present' | 'not_a_project' | 'file_exists' | 'invalid_manifest' | 'io_error'

export type AddModulePartsOptions = {
  /** The project folder: the one holding package.json and extension/extension.json. */
  dir: string
  /** Part ids (`listModuleParts`). */
  parts: readonly string[]
  /** Defaults to the `templates/` folder beside this package's `dist/`. */
  templatesRoot?: string
  /** Write over files the parts add that already exist. */
  force?: boolean
}

export type AddModulePartsResult =
  | {
      ok: true
      /** The parts added, in order, including the worker a part needed. */
      added: string[]
      /** Every file written or changed, relative to the project. */
      files: string[]
      /** Steps left to do by hand (a registration that could not be wired in). */
      notes: string[]
    }
  | { ok: false; code: ModulePartsFailureCode; message: string }

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  )
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readPart(dir: string): PartDefinition {
  const path = join(dir, PART_MANIFEST)
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  const strings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  const register = raw.register as PartDefinition['register'] | undefined
  const contributes = raw.contributes
  if (
    raw.id !== basename(dir) ||
    typeof raw.title !== 'string' ||
    typeof raw.summary !== 'string' ||
    !strings(raw.requires) ||
    !strings(raw.permissions) ||
    (raw.main !== undefined && typeof raw.main !== 'string') ||
    !isPlainRecord(contributes) ||
    !Object.entries(contributes).every(
      ([point, items]) =>
        CONTRIBUTION_POINTS.includes(point) && Array.isArray(items) && items.every((item) => isPlainRecord(item)),
    ) ||
    !isStringRecord(raw.scripts) ||
    !isStringRecord(raw.devDependencies) ||
    (register !== undefined && (typeof register.import !== 'string' || typeof register.call !== 'string'))
  ) {
    // Parts ship inside this package; a malformed one is a packaging bug.
    throw new Error(
      `${path} must be { id (the folder name), title, summary, requires, permissions, main?, contributes, scripts, devDependencies, register? }.`,
    )
  }
  return {
    id: raw.id,
    title: raw.title,
    summary: raw.summary,
    requires: [...raw.requires],
    permissions: [...raw.permissions],
    ...(typeof raw.main === 'string' ? { main: raw.main } : {}),
    contributes: contributes as PartDefinition['contributes'],
    scripts: { ...raw.scripts },
    devDependencies: { ...raw.devDependencies },
    ...(register ? { register: { ...register } } : {}),
    dir,
  }
}

function readParts(partsRoot: string): Map<string, PartDefinition> {
  const parts = new Map<string, PartDefinition>()
  if (!existsSync(partsRoot)) return parts
  for (const entry of readdirSync(partsRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && existsSync(join(partsRoot, entry.name, PART_MANIFEST))) {
      parts.set(entry.name, readPart(join(partsRoot, entry.name)))
    }
  }
  return parts
}

const partRank = (id: string): number => {
  const index = PART_ORDER.indexOf(id)
  return index === -1 ? PART_ORDER.length : index
}

/** The parts `init --with` and `sprintengine-extension add` take, in order. */
export function listModuleParts(templatesRoot: string = defaultTemplatesRoot()): ModulePartInfo[] {
  return [...readParts(join(templatesRoot, PARTS_DIR)).values()]
    .sort((a, b) => partRank(a.id) - partRank(b.id) || a.id.localeCompare(b.id))
    .map(({ id, title, summary, requires, permissions }) => ({ id, title, summary, requires, permissions }))
}

/** The id a contribution is known by within its point (an MCP tool's is its name). */
function contributionKey(item: Record<string, unknown>): string {
  return String(item.id ?? item.name ?? `${String(item.where)} ${String(item.command)}`)
}

/**
 * The parts to apply, in order, for `requested` on a project whose manifest
 * is `manifest`: each requested part after the parts it needs. Refuses an
 * unknown part, a worker the project already has, and a contribution whose id
 * the project already uses.
 */
function planParts(
  partsRoot: string,
  requested: readonly string[],
  manifest: RawManifest,
): { ok: true; plan: PartDefinition[] } | { ok: false; code: 'unknown_part' | 'already_present'; message: string } {
  const parts = readParts(partsRoot)
  const known = [...parts.keys()].sort((a, b) => partRank(a) - partRank(b))
  const plan: PartDefinition[] = []
  let hasWorker = manifest.main !== undefined
  const add = (id: string, explicit: boolean): string | null => {
    const part = parts.get(id)
    if (!part) return `There is no "${id}" part; the parts are ${known.join(', ')}.`
    if (plan.includes(part)) return null
    if (part.main !== undefined && hasWorker) {
      // A worker the project has already satisfies a part that needs one.
      if (!explicit) return null
      return `The project already has a worker (main in ${MANIFEST_PATH}); the "${id}" part adds one.`
    }
    for (const needed of part.requires) {
      if (needed === 'main' && hasWorker) continue
      const problem = add(needed, false)
      if (problem) return problem
    }
    plan.push(part)
    if (part.main !== undefined) hasWorker = true
    return null
  }
  const ordered = [...new Set(requested)].sort((a, b) => partRank(a) - partRank(b))
  for (const id of ordered) {
    const problem = add(id, true)
    if (problem) return { ok: false, code: parts.has(id) ? 'already_present' : 'unknown_part', message: problem }
  }
  const contributes = isPlainRecord(manifest.contributes) ? manifest.contributes : {}
  for (const part of plan) {
    for (const [point, items] of Object.entries(part.contributes)) {
      const existing = Array.isArray(contributes[point]) ? (contributes[point] as unknown[]) : []
      const taken = new Set(existing.filter(isPlainRecord).map(contributionKey))
      const clash = (items ?? []).find((item) => taken.has(contributionKey(item)))
      if (clash) {
        return {
          ok: false,
          code: 'already_present',
          message: `${MANIFEST_PATH} already has "${contributionKey(clash)}" in contributes.${point}; the "${part.id}" part adds one.`,
        }
      }
    }
  }
  return { ok: true, plan }
}

/**
 * Insert `importLine` after the source's imports and `call` as the first
 * statement of its `activate`. Null when `activate` is not one of the shapes
 * the templates write.
 */
function wireRegistration(source: string, importLine: string, call: string): string | null {
  const opening = [
    /^export\s+(?:async\s+)?function\s+activate\s*\(\s*(\w*)[^)]*\)[^{\n]*\{[ \t]*$/m,
    /^export\s+(?:const|let)\s+activate\b[^=\n]*=\s*(?:async\s*)?\(\s*(\w*)[^)]*\)\s*(?::[^=\n]*)?=>\s*\{[ \t]*$/m,
  ]
    .map((pattern) => pattern.exec(source))
    .find((match) => match !== null)
  if (!opening || !opening[1]) return null
  const lines = source.split('\n')
  const openingLine = source.slice(0, opening.index).split('\n').length - 1
  const param = opening[1]
  const nextLine = lines.slice(openingLine + 1).find((line) => line.trim() !== '')
  const nextIndent = /^\s*/.exec(nextLine ?? '')?.[0] ?? ''
  const indent = nextIndent.length > 0 && nextLine?.trim() !== '}' ? nextIndent : '  '
  lines.splice(openingLine + 1, 0, `${indent}${call.replace(/\bstudio\b/g, param)}`)

  if (!lines.some((line) => line.trim() === importLine.trim())) {
    let lastImport = -1
    let inImport = false
    for (const [index, line] of lines.entries()) {
      const text = line.trim()
      if (inImport) {
        if (/from\s+['"][^'"]+['"]/.test(text)) {
          inImport = false
          lastImport = index
        }
        continue
      }
      if (text.startsWith('import ')) {
        if (/from\s+['"][^'"]+['"]|^import\s+['"]/.test(text)) lastImport = index
        else inImport = true
        continue
      }
      if (text === '' || text.startsWith('//') || text.startsWith('/*') || text.startsWith('*')) continue
      break
    }
    lines.splice(lastImport + 1, 0, ...(lastImport === -1 ? [importLine, ''] : [importLine]))
  }
  return lines.join('\n')
}

// `additions` the record lacks, after what it has: a script the project
// already defines is the author's, and stays as it is.
function withScripts(record: Record<string, string> | undefined, additions: Record<string, string>) {
  const missing = Object.entries(additions).filter(([key]) => record?.[key] === undefined)
  return Object.fromEntries([...Object.entries(record ?? {}), ...missing])
}

function unionInto(list: unknown, additions: readonly string[]): string[] {
  const result = Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === 'string') : []
  for (const entry of additions) if (!result.includes(entry)) result.push(entry)
  return result
}

/** The manifest's keys in the order the format lists them, anything else after. */
function inFieldOrder(manifest: RawManifest): RawManifest {
  const order = Object.keys(EXTENSION_MANIFEST_FIELDS.fields)
  const keys = Object.keys(manifest).sort((a, b) => {
    const left = order.indexOf(a)
    const right = order.indexOf(b)
    return (left === -1 ? order.length : left) - (right === -1 ? order.length : right)
  })
  const out: RawManifest = {}
  for (const key of keys) out[key] = manifest[key]
  if (isPlainRecord(manifest.contributes)) {
    const contributes: Record<string, unknown> = {}
    const points = Object.keys(manifest.contributes).sort(
      (a, b) => CONTRIBUTION_POINTS.indexOf(a) - CONTRIBUTION_POINTS.indexOf(b),
    )
    for (const point of points) contributes[point] = manifest.contributes[point]
    out.contributes = contributes
  }
  return out
}

function isTier(value: unknown): value is ExtensionTier {
  return typeof value === 'string' && (EXTENSION_TIERS as readonly string[]).includes(value)
}

/**
 * Add parts to an existing extension project: their files, contributions,
 * permissions and worker, the tier that carries them, any scripts and
 * devDependencies they name, and the call that registers them in the worker. Expected
 * failures come back as a result, never a throw; nothing is written unless
 * the whole addition can be.
 */
export async function addModuleParts(options: AddModulePartsOptions): Promise<AddModulePartsResult> {
  const dir = resolve(options.dir)
  const templatesRoot = resolve(options.templatesRoot ?? defaultTemplatesRoot())
  const manifestPath = join(dir, MANIFEST_PATH)
  const packagePath = join(dir, 'package.json')
  if (!existsSync(manifestPath) || !existsSync(packagePath)) {
    return {
      ok: false,
      code: 'not_a_project',
      message: `${dir} is not an extension project: it needs package.json and ${MANIFEST_PATH}.`,
    }
  }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RawManifest
    if (!isPlainRecord(manifest)) {
      return { ok: false, code: 'invalid_manifest', message: `${MANIFEST_PATH} must be a JSON object.` }
    }
    const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as {
      scripts?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const planned = planParts(join(templatesRoot, PARTS_DIR), options.parts, manifest)
    if (!planned.ok) return planned

    const id = typeof manifest.id === 'string' ? manifest.id : ''
    const values: Record<string, string> = {
      id,
      displayName: displayNameFor(typeof manifest.name === 'string' ? manifest.name : '', id),
      toolPrefix: mcpToolPrefix(id),
    }
    const fill = <T>(value: T): T => JSON.parse(fillPlaceholders(JSON.stringify(value), values)) as T

    // The manifest first, and validated, so a part that would leave it invalid
    // leaves the project untouched.
    const merged: RawManifest = { ...manifest }
    const contributes: Record<string, unknown> = isPlainRecord(manifest.contributes) ? { ...manifest.contributes } : {}
    for (const part of planned.plan) {
      if (part.main !== undefined && merged.main === undefined) merged.main = part.main
      if (part.permissions.length > 0) merged.permissions = unionInto(merged.permissions, part.permissions)
      for (const [point, items] of Object.entries(fill(part.contributes))) {
        const existing = Array.isArray(contributes[point]) ? (contributes[point] as unknown[]) : []
        contributes[point] = [...existing, ...(items ?? [])]
      }
    }
    merged.contributes = contributes
    const lists = Object.fromEntries(
      CONTRIBUTION_POINTS.map((point) => [point, Array.isArray(contributes[point]) ? contributes[point] : []]),
    ) as unknown as ExtensionContributions
    const required = requiredExtensionTier({
      ...(typeof merged.main === 'string' ? { main: merged.main } : {}),
      permissions: unionInto(merged.permissions, []) as ExtensionPermission[],
      contributes: lists,
    })
    if (!isTier(merged.tier) || tierRank(merged.tier) < tierRank(required)) merged.tier = required
    const ordered = inFieldOrder(merged)
    const checked = validateExtensionManifest(ordered, { authoring: true })
    if (!checked.ok) {
      return {
        ok: false,
        code: 'invalid_manifest',
        message: `${MANIFEST_PATH} would not be valid with ${options.parts.join(', ')}:\n${checked.issues
          .map((issue) => `  - ${issue.path || 'extension.json'}: ${issue.message}`)
          .join('\n')}`,
      }
    }

    // Every file next, so a clash leaves the project untouched. A file that is
    // already there with the same content is not a clash.
    const copies: Array<{ relativePath: string; content: string }> = []
    for (const part of planned.plan) {
      for (const path of walkFiles(part.dir)) {
        if (path === PART_MANIFEST) continue
        copies.push({
          relativePath: projectPath(path),
          content: fillPlaceholders(readFileSync(join(part.dir, path), 'utf8'), values),
        })
      }
    }
    const toWrite = copies.filter((copy) => {
      const target = join(dir, copy.relativePath)
      return !existsSync(target) || readFileSync(target, 'utf8') !== copy.content
    })
    const clashes = toWrite.filter((copy) => existsSync(join(dir, copy.relativePath))).map((copy) => copy.relativePath)
    if (clashes.length > 0 && !options.force) {
      return {
        ok: false,
        code: 'file_exists',
        message: `These files are already in the project: ${clashes.join(', ')}. Move them aside, or add with force to write over them.`,
      }
    }

    const files = new Set<string>()
    for (const copy of toWrite) {
      const target = join(dir, copy.relativePath)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, copy.content)
      files.add(copy.relativePath)
    }

    // The worker's source, where a part's registration is wired in: `main` as
    // the merged manifest names it. A worker that is not TypeScript or
    // JavaScript source is told about in a note instead.
    const workerSource =
      typeof ordered.main === 'string' ? `${EXTENSION_DIR}/${ordered.main}` : `${EXTENSION_DIR}/src/main.ts`
    const notes: string[] = []
    for (const part of planned.plan) {
      pkg.scripts = withScripts(pkg.scripts, part.scripts)
      pkg.devDependencies = { ...part.devDependencies, ...pkg.devDependencies }
      if (part.register) {
        const absolute = join(dir, workerSource)
        const wired =
          /\.[cm]?[jt]s$/.test(workerSource) && existsSync(absolute)
            ? wireRegistration(readFileSync(absolute, 'utf8'), part.register.import, part.register.call)
            : null
        if (wired === null) {
          notes.push(
            `Call ${part.register.call} from activate in ${workerSource}, after \`${part.register.import}\`; ` +
              'it could not be wired in automatically.',
          )
        } else {
          writeFileSync(absolute, wired)
          files.add(workerSource)
        }
      }
    }
    pkg.devDependencies = Object.fromEntries(
      Object.entries(pkg.devDependencies ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    )

    const writeJson = (path: string, value: unknown, relativePath: string): void => {
      writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
      files.add(relativePath)
    }
    writeJson(manifestPath, ordered, MANIFEST_PATH)
    writeJson(packagePath, pkg, 'package.json')

    return { ok: true, added: planned.plan.map((part) => part.id), files: [...files].sort(), notes }
  } catch (error) {
    return {
      ok: false,
      code: 'io_error',
      message: `Could not add ${options.parts.join(', ')} to ${dir}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
