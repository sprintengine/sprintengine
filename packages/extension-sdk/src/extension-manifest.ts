// extension.json: what an extension is, what it adds to Studio, and the most
// authority it needs. One strict validator, used by the app, the
// `sprintengine-extension` CLI and the templates, so an author and Studio
// cannot disagree about a manifest.
//
// The field table below is the single description of the format: the
// validator walks it, `extensionManifestJsonSchema()` turns it into the JSON
// Schema the SDK ships (`extension.schema.json`), and
// `extensionManifestReference()` into the reference in guide/manifest.md. The
// schema covers shape, for editors; the validator is authoritative for the
// rules a schema cannot say cheaply (tiers, references between points,
// permissions a point needs).
// Unknown keys are refused at every level, so nothing can be smuggled past the
// install review by a key Studio does not read. Pure (no Node or DOM APIs).

import {
  EXTENSION_TIERS,
  isPlainObject,
  nodeJsonSchema,
  referenceRows,
  tierRank,
  validateNode,
  type ExtensionTier,
  type FieldSpec,
  type JsonSchema,
  type ManifestIssue,
  type ObjectNode,
  type SchemaNode,
} from './manifest-schema.js'
import { EXTENSION_PERMISSIONS, type ExtensionPermission } from './permissions.js'

export { EXTENSION_TIERS, type ExtensionTier, type ManifestIssue } from './manifest-schema.js'

/** The manifest's file name, at the extension's root. */
export const EXTENSION_MANIFEST_FILENAME = 'extension.json'

/** The detached signature `sprintengine-extension sign` writes beside the manifest. */
export const EXTENSION_SIGNATURE_FILENAME = 'extension.sig'

/** The first Studio that reads extension.json. */
export const EXTENSION_MANIFEST_SINCE = '0.13.0'

/**
 * The newest `since` this Studio reads. An extension whose `engines.studio`
 * asks for more is refused by name rather than loaded half-understood.
 */
export const STUDIO_EXTENSION_VERSION = EXTENSION_MANIFEST_SINCE

const V1 = EXTENSION_MANIFEST_SINCE

// ── Vocabularies ────────────────────────────────────────────────────────────

/** Icons a contribution may name; Studio draws them with its own glyphs. Grows additively. */
export const EXTENSION_ICONS = [
  'extension',
  'chat',
  'branch',
  'folder',
  'schedule',
  'spark',
  'lock',
  'settings',
  'check',
  'warning',
  'copy',
  'notes',
] as const
export type ExtensionIcon = (typeof EXTENSION_ICONS)[number]

/**
 * Studio's own commands a declarative command may run. Closed, so an
 * extension can only alias what Studio offers people anyway; each id is a
 * command in the app's command registry (a test holds them to it).
 */
export const EXTENSION_COMMAND_ACTIONS = [
  'app.settings.open',
  'commandPalette.open',
  'search.everywhere',
  'search.goToFile',
  'chat.new',
  'workspace.history.back',
  'workspace.history.forward',
  'workspace.sidebar.toggle',
  'panel.files.toggle',
  'panel.editor.toggle',
  'panel.git.toggle',
  'panel.backlog.toggle',
  'git.refresh',
  'git.fetch',
  'terminal.new',
  'usage.show',
] as const
export type ExtensionCommandAction = (typeof EXTENSION_COMMAND_ACTIONS)[number]

/** Where a menu item may appear. */
export const EXTENSION_MENU_PLACES = ['backlog.item', 'file', 'notification'] as const
export type ExtensionMenuPlace = (typeof EXTENSION_MENU_PLACES)[number]

/** Contribution points held for later formats: each must be empty for now. */
export const EXTENSION_RESERVED_POINTS: Readonly<Record<string, string>> = {
  themes: 'app color themes',
  terminalThemes: 'terminal color themes',
  iconThemes: 'file icon themes',
  syntaxes: 'syntax highlighting',
  fonts: 'font families',
  snippets: 'editor snippets',
  keybindings: 'keyboard shortcuts',
  statusBarItems: 'status bar items',
  settings: 'declared settings',
  customEditors: 'custom editors',
  newFiles: 'new file templates',
  events: 'events delivered to the worker',
  hooks: 'hooks the worker runs around Studio actions',
  sidecars: 'background processes',
  agentProviders: 'agent providers',
  skills: 'agent skills (a plugin bundle carries them for now)',
  mcpServers: 'MCP server definitions (a plugin bundle carries them for now)',
  providers: 'model providers (the provider folder carries them for now)',
}

// ── Field rules ─────────────────────────────────────────────────────────────

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const COMMAND_ID_RE = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/
// A numeric prerelease identifier has no leading zero (`1.0.0-01` is not semver).
const SEMVER_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const ENGINE_RE = /^>=(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const MCP_TOOL_RE = /^[a-z][a-z0-9_]*$/
// C0 and C1 controls, and the bidirectional overrides that make text read
// differently from what it is.
const UNSAFE_TEXT_RE = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/u
const WINDOWS_DEVICE_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

/** Whether a manifest path stays inside the extension on every platform. */
export function isSafeExtensionPath(value: string): boolean {
  if (value.length === 0 || value.length > 1024) return false
  if (value.startsWith('/') || value.includes('\\') || value.includes(':') || value.includes('\0')) return false
  return value
    .split('/')
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== '.' &&
        segment !== '..' &&
        !WINDOWS_DEVICE_RE.test(segment) &&
        !/[<>"|?*]/.test(segment) &&
        !segment.endsWith('.') &&
        !segment.endsWith(' '),
    )
}

function idCheck(value: string): string | null {
  return value === 'constructor' || value === 'prototype' ? 'must not be a reserved name.' : null
}

const idNode = (): SchemaNode => ({
  kind: 'string',
  min: 1,
  max: 63,
  pattern: ID_RE,
  patternMessage: 'must be kebab-case: a–z, 0–9 and single dashes.',
  check: idCheck,
})

const displayText = (max: number, min = 1): SchemaNode => ({
  kind: 'string',
  min,
  max,
  check: (value) => (UNSAFE_TEXT_RE.test(value) ? 'must not hold control or text-direction characters.' : null),
})

// What JSON Schema can say of a safe path: relative, `/` between folders, no
// `.` or `..` segment, no empty segment, no backslash, colon or control
// character. Device names stay the validator's.
const SAFE_PATH_SCHEMA = String.raw`^(?!/)(?!.*(?:^|/)\.{1,2}(?:/|$))(?!.*//)[^\\:<>"|?*\u0000-\u001f]+`

// A suffix as the validator compares it, whatever its case: `.png` is
// `\.[Pp][Nn][Gg]`.
function caselessSuffix(extension: string): string {
  return [...extension]
    .map((char) => (char === '.' ? '\\.' : /[a-z]/.test(char) ? `[${char.toUpperCase()}${char}]` : char))
    .join('')
}

const pathNode = (extensions?: readonly string[]): SchemaNode => ({
  kind: 'string',
  min: 1,
  max: 1024,
  schemaPattern: `${SAFE_PATH_SCHEMA}${extensions ? `(?:${extensions.map(caselessSuffix).join('|')})` : ''}$`,
  check: (value) => {
    if (!isSafeExtensionPath(value)) {
      return 'must be a relative path inside the extension, with / between folders and no "..", device names or drive letters.'
    }
    if (extensions && !extensions.some((extension) => value.toLowerCase().endsWith(extension))) {
      return `must end in ${extensions.join(', ')}.`
    }
    return null
  },
})

const httpsUrl = (): SchemaNode => ({
  kind: 'string',
  min: 1,
  max: 2048,
  pattern: /^https:\/\/[^\s]+$/,
  patternMessage: 'must be an https:// URL.',
})

const IMAGE_EXTENSIONS = ['.png', '.svg', '.jpg', '.jpeg', '.webp'] as const
const SCRIPT_EXTENSIONS = ['.js', '.mjs', '.cjs'] as const
const UI_ENTRY_EXTENSIONS = ['.js', '.mjs'] as const

const iconField = (doc: string): FieldSpec => ({
  node: { kind: 'string', max: 32, enum: EXTENSION_ICONS },
  doc: `${doc} Defaults to \`extension\`.`,
  since: V1,
  example: 'notes',
})

const surfaceObject = (title: string, entryDoc: string): ObjectNode => ({
  kind: 'object',
  title,
  fields: {
    id: { node: idNode(), required: true, doc: 'Id, unique within this point.', since: V1, example: 'notes' },
    title: { node: displayText(64), required: true, doc: 'What Studio calls it.', since: V1, example: 'Notes' },
    icon: iconField('Glyph beside the title.'),
    entry: {
      node: pathNode(UI_ENTRY_EXTENSIONS),
      required: true,
      doc: `${entryDoc} A \`.js\` or \`.mjs\` module whose \`mount(root, studio)\` draws into \`root\` and may return a cleanup function.`,
      since: V1,
      example: 'dist/notes.js',
    },
  },
})

const byId = { key: (item: unknown) => String((item as { id: string }).id), label: 'id' }

const CONTRIBUTES: ObjectNode = {
  kind: 'object',
  fields: {
    commands: {
      node: {
        kind: 'array',
        max: 256,
        unique: byId,
        items: {
          kind: 'object',
          title: 'CommandContribution',
          fields: {
            id: {
              node: {
                kind: 'string',
                min: 1,
                max: 100,
                pattern: COMMAND_ID_RE,
                patternMessage: 'must be lower-case words joined by dots or dashes.',
              },
              required: true,
              doc: 'Command id, unique among this extension’s commands. Without `action`, running the command calls the worker method of this name (`registerMethods`, access `operate`).',
              since: V1,
              example: 'notes.clear',
            },
            title: {
              node: displayText(128),
              required: true,
              doc: 'Title in the command palette and in menus.',
              since: V1,
              example: 'Clear notes',
            },
            when: {
              node: { kind: 'string', max: 16, enum: ['global', 'workspace'] },
              doc: 'Where the command is offered. `workspace` hides it while no workspace is open. Defaults to `global`.',
              since: V1,
            },
            action: {
              node: { kind: 'string', max: 64, enum: EXTENSION_COMMAND_ACTIONS },
              doc: 'A Studio command this command runs. A command with an `action` is declarative and runs no extension code; one without needs the worker tier.',
              since: V1,
              example: 'panel.backlog.toggle',
            },
          },
        },
      },
      doc: 'Command palette entries.',
      since: V1,
      tier: 'declarative',
    },
    menus: {
      node: {
        kind: 'array',
        max: 64,
        unique: {
          key: (item) => `${(item as { where: string }).where} ${(item as { command: string }).command}`,
          label: 'menu item',
        },
        items: {
          kind: 'object',
          title: 'MenuContribution',
          fields: {
            where: {
              node: { kind: 'string', max: 32, enum: EXTENSION_MENU_PLACES },
              required: true,
              doc: 'The menu: a backlog item’s, a file’s in the Files tree, or one of this extension’s own notifications.',
              since: V1,
            },
            command: {
              node: { kind: 'string', min: 1, max: 100, pattern: COMMAND_ID_RE },
              required: true,
              doc: 'A command this extension contributes. Its title is the menu item’s label, and it runs with the item it was picked on.',
              since: V1,
              example: 'notes.clear',
            },
          },
        },
      },
      doc: 'Items in Studio’s own menus.',
      since: V1,
      tier: 'declarative',
    },
    topBarItems: {
      node: {
        kind: 'array',
        max: 8,
        unique: byId,
        items: {
          kind: 'object',
          title: 'TopBarItemContribution',
          fields: {
            id: { node: idNode(), required: true, doc: 'Id, unique among this extension’s top bar items.', since: V1 },
            title: { node: displayText(64), required: true, doc: 'The button’s name and tooltip.', since: V1 },
            icon: iconField('The button’s glyph.'),
            command: {
              node: { kind: 'string', min: 1, max: 100, pattern: COMMAND_ID_RE },
              doc: 'A contributed command the button runs. Give `command` or `door`, not both.',
              since: V1,
            },
            door: { node: idNode(), doc: 'A contributed door the button opens.', since: V1 },
          },
        },
      },
      doc: 'Buttons in the top bar.',
      since: V1,
      tier: 'declarative',
    },
    panels: {
      node: {
        kind: 'array',
        max: 16,
        unique: byId,
        items: surfaceObject('PanelContribution', 'What the panel draws, as a tab in a workspace’s pane.'),
      },
      doc: 'Pane tabs, offered by the pane’s + menu.',
      since: V1,
      tier: 'ui',
    },
    doors: {
      node: {
        kind: 'array',
        max: 8,
        unique: byId,
        items: surfaceObject('DoorContribution', 'What the door draws when it is open.'),
      },
      doc: 'Full-window surfaces, opened from the Extensions drawer.',
      since: V1,
      tier: 'ui',
    },
    settingsSections: {
      node: {
        kind: 'array',
        max: 4,
        unique: byId,
        items: surfaceObject('SettingsSectionContribution', 'What the section draws in Settings.'),
      },
      doc: 'Sections in Settings.',
      since: V1,
      tier: 'ui',
    },
    mcpTools: {
      node: {
        kind: 'array',
        max: 64,
        unique: { key: (item) => String((item as { name: string }).name), label: 'tool name' },
        items: {
          kind: 'object',
          title: 'McpToolContribution',
          fields: {
            name: {
              node: {
                kind: 'string',
                min: 1,
                max: 64,
                pattern: MCP_TOOL_RE,
                patternMessage: 'must be lower-case letters, digits and underscores, starting with a letter.',
              },
              required: true,
              doc: 'The tool’s name on Studio’s MCP server. The worker serves it with `registerMcpTools`; a tool it registers that is not declared here is refused.',
              since: V1,
              example: 'notes_search',
            },
            description: {
              node: displayText(1024),
              required: true,
              doc: 'What agents are told the tool does.',
              since: V1,
            },
            access: {
              node: { kind: 'string', max: 16, enum: ['read', 'operate'] },
              required: true,
              doc: '`read` changes nothing; `operate` may, and agents are asked before it runs where their settings say so.',
              since: V1,
            },
          },
        },
      },
      doc: 'Tools agents reach through Studio’s MCP server. Needs the `tools:contribute` permission.',
      since: V1,
      tier: 'worker',
    },
    ...Object.fromEntries(
      Object.entries(EXTENSION_RESERVED_POINTS).map(([point, purpose]): [string, FieldSpec] => [
        point,
        { node: { kind: 'reserved', purpose }, doc: `Reserved for ${purpose}.`, since: V1 },
      ]),
    ),
  },
}

/** The whole format, field by field. */
export const EXTENSION_MANIFEST_FIELDS: ObjectNode = {
  kind: 'object',
  title: 'SprintEngine Studio extension manifest',
  fields: {
    $schema: {
      node: { kind: 'string', max: 2048 },
      doc: 'JSON Schema URL for editor completion. Studio ignores it.',
      since: V1,
      ignored: true,
    },
    manifestVersion: {
      node: { kind: 'literal', value: 1 },
      required: true,
      doc: 'The manifest format. Always `1`.',
      since: V1,
    },
    id: {
      node: idNode(),
      required: true,
      doc: 'Extension id, kebab-case. Studio installs it under `<publisher>.<id>`, the publisher derived from where it came from (`local` for a folder). Ids starting `studio-` or `sprintengine-` install only from Studio’s own catalogue.',
      since: V1,
      example: 'notes',
    },
    version: {
      node: {
        kind: 'string',
        min: 1,
        max: 64,
        pattern: SEMVER_RE,
        patternMessage: 'must be a semver version, such as 1.0.0.',
      },
      required: true,
      doc: 'The extension’s version, semver.',
      since: V1,
      example: '1.0.0',
    },
    engines: {
      node: {
        kind: 'object',
        fields: {
          studio: {
            node: { kind: 'string', min: 1, max: 32, pattern: ENGINE_RE, patternMessage: 'must be >=x.y.z.' },
            required: true,
            doc: 'The oldest Studio it runs on, as `>=x.y.z`: at least the newest “since” of any field it uses.',
            since: V1,
            example: `>=${V1}`,
          },
        },
      },
      required: true,
      doc: 'The Studio versions it runs on.',
      since: V1,
    },
    tier: {
      node: { kind: 'string', max: 16, enum: EXTENSION_TIERS },
      required: true,
      doc: 'The most authority it needs, least first: `content`, `declarative` (commands, menus, top bar items), `ui` (panels, doors, settings sections, drawn by its own code), `worker` (`main`, running in the background). Each carries what the ones below it do; a contribution above it fails validation.',
      since: V1,
      example: 'ui',
    },
    name: { node: displayText(64), required: true, doc: 'Display name.', since: V1, example: 'Notes' },
    description: { node: displayText(512, 0), doc: 'One or two sentences shown with the name.', since: V1 },
    icon: {
      node: pathNode(IMAGE_EXTENSIONS),
      doc: 'A square image shown beside the name.',
      since: V1,
      example: 'assets/icon.png',
    },
    cover: { node: pathNode(IMAGE_EXTENSIONS), doc: 'A wide image for its listing.', since: V1 },
    screenshots: {
      node: { kind: 'array', max: 8, items: pathNode(IMAGE_EXTENSIONS) },
      doc: 'Images of it at work, for its listing.',
      since: V1,
    },
    license: {
      node: {
        kind: 'string',
        min: 1,
        max: 64,
        pattern: /^[A-Za-z0-9.+()-]+(?: (?:OR|AND|WITH) [A-Za-z0-9.+()-]+)*$/,
        patternMessage: 'must be an SPDX licence expression, such as MIT.',
      },
      doc: 'Its licence, as an SPDX expression.',
      since: V1,
      example: 'MIT',
    },
    repository: { node: httpsUrl(), doc: 'Where its source lives.', since: V1 },
    homepage: { node: httpsUrl(), doc: 'Its home page.', since: V1 },
    permissions: {
      node: {
        kind: 'array',
        max: 32,
        unique: { key: String, label: 'permission' },
        items: { kind: 'string', max: 64, enum: EXTENSION_PERMISSIONS },
      },
      doc: 'What it asks the person to allow. `content` and `declarative` extensions hold none.',
      since: V1,
      tier: 'ui',
      example: ['storage:own'],
    },
    main: {
      node: pathNode(SCRIPT_EXTENSIONS),
      doc: 'The worker’s entry: a module whose `activate(studio)` (its default export, or a named `activate`) registers what it serves. Worker tier only, and required by it.',
      since: V1,
      tier: 'worker',
      example: 'dist/main.js',
    },
    background: {
      node: { kind: 'boolean' },
      doc: '`true` keeps the worker running while the extension is on.',
      since: V1,
      tier: 'worker',
    },
    contributes: { node: CONTRIBUTES, doc: 'What it adds to Studio. Every point defaults to empty.', since: V1 },
  },
}

// ── The validated shape ─────────────────────────────────────────────────────

export type ExtensionCommandContribution = {
  id: string
  title: string
  when?: 'global' | 'workspace'
  action?: ExtensionCommandAction
}
export type ExtensionMenuContribution = { where: ExtensionMenuPlace; command: string }
export type ExtensionTopBarItemContribution = {
  id: string
  title: string
  icon?: ExtensionIcon
  command?: string
  door?: string
}
/** A panel, door or settings section: drawn by its own `entry`. */
export type ExtensionSurfaceContribution = { id: string; title: string; icon?: ExtensionIcon; entry: string }
export type ExtensionMcpToolContribution = { name: string; description: string; access: 'read' | 'operate' }

export type ExtensionContributions = {
  commands: ExtensionCommandContribution[]
  menus: ExtensionMenuContribution[]
  topBarItems: ExtensionTopBarItemContribution[]
  panels: ExtensionSurfaceContribution[]
  doors: ExtensionSurfaceContribution[]
  settingsSections: ExtensionSurfaceContribution[]
  mcpTools: ExtensionMcpToolContribution[]
}

export type ExtensionManifest = {
  manifestVersion: 1
  id: string
  version: string
  engines: { studio: string }
  tier: ExtensionTier
  name: string
  description?: string
  icon?: string
  cover?: string
  screenshots?: string[]
  license?: string
  repository?: string
  homepage?: string
  permissions: ExtensionPermission[]
  main?: string
  background?: boolean
  contributes: ExtensionContributions
}

/** The points a ui contribution's entry draws: one `mount` per contribution. */
export const EXTENSION_SURFACE_POINTS = ['panels', 'doors', 'settingsSections'] as const
export type ExtensionSurfacePoint = (typeof EXTENSION_SURFACE_POINTS)[number]

export type ExtensionManifestResult = { ok: true; manifest: ExtensionManifest } | { ok: false; issues: ManifestIssue[] }

export type ExtensionManifestValidationOptions = {
  /**
   * Hold `engines.studio` to the newest `since` the manifest uses, as an
   * author's tools do. Studio itself checks only that it can read everything
   * the manifest asks for (`STUDIO_EXTENSION_VERSION`).
   */
  authoring?: boolean
}

const EMPTY_CONTRIBUTIONS = (): ExtensionContributions => ({
  commands: [],
  menus: [],
  topBarItems: [],
  panels: [],
  doors: [],
  settingsSections: [],
  mcpTools: [],
})

/** Compare two `x.y.z` versions. */
export function compareStudioVersions(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/** The least tier a manifest's contents need. */
export function requiredExtensionTier(
  manifest: Pick<ExtensionManifest, 'main' | 'background' | 'permissions' | 'contributes'>,
): ExtensionTier {
  let required: ExtensionTier = 'content'
  const raise = (tier: ExtensionTier) => {
    if (tierRank(tier) > tierRank(required)) required = tier
  }
  if (manifest.main !== undefined || manifest.background !== undefined) raise('worker')
  if (manifest.permissions.length > 0) raise('ui')
  for (const [point, field] of Object.entries(CONTRIBUTES.fields)) {
    const list = (manifest.contributes as Record<string, unknown[] | undefined>)[point]
    if (field.tier && list && list.length > 0) raise(field.tier)
  }
  if (manifest.contributes.commands.some((command) => command.action === undefined)) raise('worker')
  return required
}

function crossFieldIssues(manifest: ExtensionManifest, options: ExtensionManifestValidationOptions): ManifestIssue[] {
  const issues: ManifestIssue[] = []
  const { contributes } = manifest
  const required = requiredExtensionTier(manifest)
  if (tierRank(manifest.tier) < tierRank(required)) {
    issues.push({
      path: 'tier',
      message: `"${manifest.tier}" cannot carry what this manifest declares, which needs "${required}".`,
    })
  }
  if (manifest.tier === 'worker' && manifest.main === undefined) {
    issues.push({ path: 'main', message: 'is required by the worker tier.' })
  }
  const commandIds = new Set(contributes.commands.map((command) => command.id))
  const doorIds = new Set(contributes.doors.map((door) => door.id))
  contributes.menus.forEach((menu, index) => {
    if (!commandIds.has(menu.command)) {
      issues.push({
        path: `contributes.menus[${index}].command`,
        message: `names no contributed command: ${menu.command}.`,
      })
    }
  })
  contributes.topBarItems.forEach((item, index) => {
    const path = `contributes.topBarItems[${index}]`
    if ((item.command === undefined) === (item.door === undefined)) {
      issues.push({ path, message: 'must give exactly one of command and door.' })
    } else if (item.command !== undefined && !commandIds.has(item.command)) {
      issues.push({ path: `${path}.command`, message: `names no contributed command: ${item.command}.` })
    } else if (item.door !== undefined && !doorIds.has(item.door)) {
      issues.push({ path: `${path}.door`, message: `names no contributed door: ${item.door}.` })
    }
  })
  if (contributes.mcpTools.length > 0 && !manifest.permissions.includes('tools:contribute')) {
    issues.push({ path: 'contributes.mcpTools', message: 'needs the "tools:contribute" permission.' })
  }
  const engine = manifest.engines.studio.slice(2)
  if (compareStudioVersions(engine, EXTENSION_MANIFEST_SINCE) < 0) {
    issues.push({
      path: 'engines.studio',
      message: `must be at least >=${EXTENSION_MANIFEST_SINCE}, the first Studio that reads extension.json.`,
    })
  } else if (options.authoring) {
    const newest = newestSinceUsed(manifest)
    if (compareStudioVersions(engine, newest) < 0) {
      issues.push({
        path: 'engines.studio',
        message: `must be at least >=${newest}, the newest “since” of the fields it uses.`,
      })
    }
  }
  return issues
}

function newestSinceUsed(manifest: ExtensionManifest): string {
  let newest = EXTENSION_MANIFEST_SINCE
  const visit = (node: ObjectNode, value: Record<string, unknown>) => {
    for (const [key, field] of Object.entries(node.fields)) {
      const child = value[key]
      if (child === undefined || (Array.isArray(child) && child.length === 0)) continue
      if (compareStudioVersions(field.since, newest) > 0) newest = field.since
      const inner = field.node.kind === 'array' ? field.node.items : field.node
      if (inner.kind !== 'object') continue
      for (const item of Array.isArray(child) ? child : [child]) {
        if (isPlainObject(item)) visit(inner, item)
      }
    }
  }
  visit(EXTENSION_MANIFEST_FIELDS, manifest as unknown as Record<string, unknown>)
  return newest
}

/** Validate a parsed extension.json. Unknown keys are refused at every level. */
export function validateExtensionManifest(
  value: unknown,
  options: ExtensionManifestValidationOptions = {},
): ExtensionManifestResult {
  if (!isPlainObject(value))
    return { ok: false, issues: [{ path: '', message: 'extension.json must be a JSON object.' }] }
  const issues: ManifestIssue[] = []
  const cleaned = validateNode(EXTENSION_MANIFEST_FIELDS, value, '', issues) as Record<string, unknown> | undefined
  if (issues.length > 0 || !cleaned) return { ok: false, issues }
  const contributes = { ...EMPTY_CONTRIBUTIONS(), ...pickKnownPoints(cleaned.contributes) }
  const manifest = {
    ...cleaned,
    permissions: (cleaned.permissions as ExtensionPermission[] | undefined) ?? [],
    contributes,
  } as ExtensionManifest
  const crossIssues = crossFieldIssues(manifest, options)
  return crossIssues.length > 0 ? { ok: false, issues: crossIssues } : { ok: true, manifest }
}

function pickKnownPoints(value: unknown): Partial<ExtensionContributions> {
  if (!isPlainObject(value)) return {}
  const out: Record<string, unknown> = {}
  for (const point of Object.keys(EMPTY_CONTRIBUTIONS())) if (value[point] !== undefined) out[point] = value[point]
  return out as Partial<ExtensionContributions>
}

/** Parse and validate extension.json's text. */
export function parseExtensionManifest(
  source: string,
  options: ExtensionManifestValidationOptions = {},
): ExtensionManifestResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    return {
      ok: false,
      issues: [
        { path: '', message: `extension.json is not JSON: ${error instanceof Error ? error.message : 'parse error'}.` },
      ],
    }
  }
  return validateExtensionManifest(parsed, options)
}

/**
 * Whether Studio can run an extension that asks for `engines.studio`: it reads
 * every field up to `STUDIO_EXTENSION_VERSION`.
 */
export function studioReadsManifest(
  manifest: Pick<ExtensionManifest, 'engines'>,
): { ok: true } | { ok: false; message: string } {
  const wanted = manifest.engines.studio.slice(2)
  if (compareStudioVersions(wanted, STUDIO_EXTENSION_VERSION) <= 0) return { ok: true }
  return {
    ok: false,
    message: `It needs Studio ${wanted} or newer, and this Studio reads extensions written for ${STUDIO_EXTENSION_VERSION}.`,
  }
}

// ── Install keys ────────────────────────────────────────────────────────────

/** The publisher of an extension installed from a folder. */
export const LOCAL_EXTENSION_PUBLISHER = 'local'

const RESERVED_PUBLISHERS = new Set(['sprintengine', 'official', 'local'])
const PUBLISHER_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Publishers only Studio itself may assign: its own, the official catalogue’s and a folder’s. */
export function isReservedExtensionPublisher(publisher: string): boolean {
  return RESERVED_PUBLISHERS.has(publisher) || publisher.startsWith('studio')
}

/** Ids that install only from Studio’s own catalogue. */
export function isReservedExtensionId(id: string): boolean {
  return id.startsWith('studio-') || id.startsWith('sprintengine-')
}

/** The install key `<publisher>.<id>`: the folder it lives in and the id the Studio protocol names it by. */
export function extensionInstallKey(publisher: string, id: string): string {
  return `${publisher}.${id}`
}

/** A key's two halves, or null for anything that is not one. */
export function parseExtensionInstallKey(key: string): { publisher: string; id: string } | null {
  const dot = key.indexOf('.')
  if (dot <= 0) return null
  const publisher = key.slice(0, dot)
  const id = key.slice(dot + 1)
  if (!PUBLISHER_RE.test(publisher) || publisher.length > 39) return null
  if (!ID_RE.test(id) || id.length > 63 || idCheck(id) !== null) return null
  return { publisher, id }
}

/** Whether a string is an install key. */
export function isExtensionInstallKey(value: unknown): value is string {
  return typeof value === 'string' && parseExtensionInstallKey(value) !== null
}

// ── Generated artefacts ─────────────────────────────────────────────────────

/** The JSON Schema of extension.json, as the SDK ships it in `extension.schema.json`. */
export function extensionManifestJsonSchema(): JsonSchema {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://sprintengine.dev/schemas/extension.schema.json',
    ...nodeJsonSchema(EXTENSION_MANIFEST_FIELDS),
    // The worker tier needs its worker.
    allOf: [
      {
        if: { properties: { tier: { const: 'worker' } }, required: ['tier'] },
        // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema's own keyword, never awaited
        then: { required: ['main'] },
      },
    ],
  }
}

/** The field reference guide/manifest.md carries between its generated markers. */
export function extensionManifestReference(): string {
  const escape = (text: string) => text.replaceAll('|', '\\|')
  const lines = [
    '| Field | Type | Required | Since | Tier | Description |',
    '|---|---|---|---|---|---|',
    ...referenceRows(EXTENSION_MANIFEST_FIELDS)
      .filter(
        (row) =>
          !row.path.startsWith('contributes.') || !(row.path.slice('contributes.'.length) in EXTENSION_RESERVED_POINTS),
      )
      .map(
        (row) =>
          `| \`${row.path}\` | ${row.type} | ${row.required ? 'yes' : ''} | ${row.since} | ${row.tier ?? ''} | ${escape(row.doc)} |`,
      ),
    '',
    `Reserved, and must be empty for now: ${Object.keys(EXTENSION_RESERVED_POINTS)
      .map((point) => `\`contributes.${point}\``)
      .join(', ')}.`,
    '',
    `Icons: ${EXTENSION_ICONS.map((icon) => `\`${icon}\``).join(', ')}.`,
    '',
    `Command actions: ${EXTENSION_COMMAND_ACTIONS.map((action) => `\`${action}\``).join(', ')}.`,
  ]
  return lines.join('\n')
}
