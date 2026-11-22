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
import { SCOPE_NAME_RE } from './content-syntaxes.js'
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
  fonts: 'font families',
  snippets: 'editor snippets',
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

const KEYBINDING_MODIFIERS = new Set([
  'mod',
  'primary',
  'cmd',
  'command',
  'ctrl',
  'control',
  'alt',
  'option',
  'opt',
  'meta',
  'super',
  'win',
  'shift',
])
const KEYBINDING_NAMED_KEYS = new Set([
  'enter',
  'escape',
  'esc',
  'tab',
  'space',
  'backspace',
  'delete',
  'insert',
  'home',
  'end',
  'pageup',
  'pagedown',
  'up',
  'down',
  'left',
  'right',
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
])
const FUNCTION_KEY_RE = /^f(?:[1-9]|1\d|2[0-4])$/

/**
 * Why a key chord is not one Studio binds, or null: modifiers and one key
 * joined by `+`, such as `Mod+Shift+K`, with at least one modifier other than
 * Shift unless the key is a function key. `Mod` is Cmd on macOS and Ctrl
 * elsewhere.
 */
export function keybindingProblem(value: string): string | null {
  const parts = value.split('+').map((part) => part.trim())
  if (value.endsWith('+')) parts.splice(-2, 2, '+')
  const key = parts.pop() ?? ''
  const modifiers = parts.map((part) => part.toLowerCase())
  if (modifiers.some((modifier) => !KEYBINDING_MODIFIERS.has(modifier)))
    return 'names a modifier Studio does not know: use Mod, Ctrl, Alt, Shift or Meta.'
  if (new Set(modifiers).size !== modifiers.length) return 'names a modifier twice.'
  const lower = key.toLowerCase()
  const isFunction = FUNCTION_KEY_RE.test(lower)
  if (!(isFunction || KEYBINDING_NAMED_KEYS.has(lower) || (/^\S$/u.test(key) && !UNSAFE_TEXT_RE.test(key))))
    return 'must end in one key: a character, a function key (F1–F24) or a named key such as Enter.'
  if (!isFunction && !modifiers.some((modifier) => modifier !== 'shift'))
    return 'needs a modifier other than Shift (Mod, Ctrl, Alt or Meta), so typing never runs it.'
  if (isReservedChord(modifiers, lower))
    return 'is a key the system or the browser keeps (copy, paste, undo, close, reload and their like), so Studio does not let an extension take it.'
  return null
}

// The command modifier, whatever it is called: on macOS Cmd, elsewhere Ctrl,
// and a chord on either is the platform's.
const PRIMARY_MODIFIERS = new Set(['mod', 'primary', 'cmd', 'command', 'ctrl', 'control', 'meta', 'super', 'win'])
// Keys the platform, the window or the browser own under the command
// modifier alone: clipboard and selection, undo and redo, find, print, save,
// and the window's and tab's own (quit, close, hide, minimise, reload, new,
// open tab, address bar). Taken by an extension they would stop doing what
// every app does with them, with no prompt to say so.
const RESERVED_PRIMARY_KEYS = new Set([
  'a',
  'c',
  'v',
  'x',
  'z',
  'y',
  'f',
  'g',
  'p',
  's',
  'q',
  'w',
  'h',
  'm',
  'r',
  't',
  'n',
  'l',
  'o',
  '+',
  '-',
  '=',
  '0',
])
// The same with Shift: redo, reopen a closed tab, a new private window, a hard reload.
const RESERVED_PRIMARY_SHIFT_KEYS = new Set(['z', 't', 'n', 'r', 'w', 'g'])
// Function keys a browser or the system keep, with any modifier: reload,
// full screen and developer tools; and Alt+F4's close.
const RESERVED_FUNCTION_KEYS = new Set(['f5', 'f11', 'f12'])

/** Whether a chord is one the platform or the browser keeps. */
function isReservedChord(modifiers: readonly string[], key: string): boolean {
  const primary = modifiers.filter((modifier) => PRIMARY_MODIFIERS.has(modifier))
  const shift = modifiers.includes('shift')
  const alt = modifiers.some((modifier) => modifier === 'alt' || modifier === 'option' || modifier === 'opt')
  if (RESERVED_FUNCTION_KEYS.has(key)) return true
  if (key === 'f4' && alt) return true
  // Developer tools and the console.
  if (primary.length === 1 && alt && (key === 'i' || key === 'j')) return true
  if (primary.length === 0 || alt) return false
  if (primary.length === 1 && !shift) return RESERVED_PRIMARY_KEYS.has(key)
  if (primary.length === 1 && shift) return RESERVED_PRIMARY_SHIFT_KEYS.has(key)
  return false
}

// A command id of the extension's own (lower case), or one of Studio's
// actions, some of which are camel-cased (`commandPalette.open`).
const COMMAND_REF_RE = /^[a-z][A-Za-z0-9]*(?:[.-][A-Za-z0-9]+)*$/

const commandRef = (doc: string): FieldSpec => ({
  node: {
    kind: 'string',
    min: 1,
    max: 100,
    pattern: COMMAND_REF_RE,
    patternMessage: 'must be a command id: words joined by dots or dashes.',
  },
  doc: `${doc} Either a command this extension contributes in \`contributes.commands\`, or one of Studio’s own command actions (listed below), which a content extension may bind without any code.`,
  since: V1,
  example: 'panel.git.toggle',
})

/** The types a declared setting may have. */
export const EXTENSION_SETTING_TYPES = ['string', 'number', 'integer', 'boolean'] as const
export type ExtensionSettingType = (typeof EXTENSION_SETTING_TYPES)[number]
const SETTING_KEY_RE = /^[A-Za-z][A-Za-z0-9_.-]*$/
const FILE_SUFFIX_RE = /^\.[A-Za-z0-9_+-][A-Za-z0-9_.+-]*$/
const PORTABLE_NAME_RE = /^[^<>:"/\\|?*\u0000-\u001f]+$/

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
    syntaxes: {
      node: {
        kind: 'array',
        max: 16,
        unique: byId,
        items: {
          kind: 'object',
          title: 'SyntaxContribution',
          fields: {
            id: {
              node: idNode(),
              required: true,
              doc: 'Language id, unique among this extension’s syntaxes. A chat code block whose fence names it (```gleam), or one of its extensions without the dot, is highlighted with it.',
              since: V1,
              example: 'gleam',
            },
            title: { node: displayText(64), required: true, doc: 'The language’s name.', since: V1, example: 'Gleam' },
            scopeName: {
              node: {
                kind: 'string',
                min: 3,
                max: 128,
                pattern: SCOPE_NAME_RE,
                patternMessage: 'must be a dotted TextMate scope, such as source.gleam.',
              },
              required: true,
              doc: 'The grammar’s root scope, unique among this extension’s syntaxes; the grammar file’s own `scopeName` must match.',
              since: V1,
              example: 'source.gleam',
            },
            path: {
              node: pathNode(['.json']),
              required: true,
              doc: 'A TextMate grammar in JSON, at most 1 MiB. Keys a TextMate engine does not read are dropped; every `#name` it includes must name a rule in a repository.',
              since: V1,
              example: 'syntaxes/gleam.tmLanguage.json',
            },
            configuration: {
              node: pathNode(['.json']),
              doc: 'A language configuration, at most 64 KiB: `comments`, `brackets`, `autoClosingPairs` and `surroundingPairs`, which the editor reads.',
              since: V1,
              example: 'syntaxes/language-configuration.json',
            },
            extensions: {
              node: {
                kind: 'array',
                max: 32,
                unique: { key: (item) => String(item).toLowerCase(), label: 'extension' },
                items: {
                  kind: 'string',
                  min: 2,
                  max: 64,
                  pattern: FILE_SUFFIX_RE,
                  patternMessage: 'must be a file-name suffix with its dot, such as .gleam.',
                },
              },
              doc: 'File-name suffixes the editor opens in this language, ignoring case. A longer suffix wins over a shorter one, and one of Studio’s own languages that drives completions (TypeScript, JavaScript, JSON, CSS, SCSS, Less, HTML, Markdown) is never replaced.',
              since: V1,
              example: ['.gleam'],
            },
            filenames: {
              node: {
                kind: 'array',
                max: 32,
                unique: { key: (item) => String(item).toLowerCase(), label: 'file name' },
                items: {
                  kind: 'string',
                  min: 1,
                  max: 128,
                  pattern: PORTABLE_NAME_RE,
                  patternMessage: 'must be a file name with no folder or characters Windows forbids.',
                  check: (value) => (value === '.' || value === '..' ? 'must be a file name.' : null),
                },
              },
              doc: 'Exact file names the editor opens in this language, ignoring case; a name wins over any suffix.',
              since: V1,
              example: ['gleam.toml'],
            },
          },
        },
      },
      doc: 'Syntax highlighting for a language, in chat code blocks and the editor.',
      since: V1,
      tier: 'content',
    },
    keybindings: {
      node: {
        kind: 'array',
        max: 64,
        unique: { key: (item) => String((item as { key: string }).key).toLowerCase(), label: 'key' },
        items: {
          kind: 'object',
          title: 'KeybindingContribution',
          fields: {
            command: { ...commandRef('The command the key runs.'), required: true },
            key: {
              node: { kind: 'string', min: 1, max: 64, check: keybindingProblem },
              required: true,
              doc: 'The key chord: modifiers and one key joined by `+`. `Mod` is Cmd on macOS and Ctrl elsewhere. It can be changed or removed in Settings ▸ Shortcuts like any of Studio’s.',
              since: V1,
              example: 'Mod+Alt+G',
            },
            when: {
              node: { kind: 'string', max: 16, enum: ['global', 'workspace'] },
              doc: 'Where the key works. `workspace` only while a workspace is open. Defaults to `global`.',
              since: V1,
            },
          },
        },
      },
      doc: 'Keyboard shortcuts.',
      since: V1,
      tier: 'content',
    },
    statusBarItems: {
      node: {
        kind: 'array',
        max: 8,
        unique: byId,
        items: {
          kind: 'object',
          title: 'StatusBarItemContribution',
          fields: {
            id: {
              node: idNode(),
              required: true,
              doc: 'Id, unique among this extension’s status bar items.',
              since: V1,
            },
            text: {
              node: displayText(32),
              doc: 'A short label. Give `text`, `icon` or both.',
              since: V1,
              example: 'Gleam',
            },
            icon: { ...iconField('A glyph before the text.'), doc: 'A glyph before the text.' },
            tooltip: { node: displayText(128), doc: 'Shown on hover. Defaults to the extension’s name.', since: V1 },
            command: commandRef('The command pressing the item runs. Without one, the item only shows.'),
          },
        },
      },
      doc: 'Short status items, shown in the window’s band beside the top bar.',
      since: V1,
      tier: 'content',
    },
    settings: {
      node: {
        kind: 'array',
        max: 64,
        unique: { key: (item) => String((item as { key: string }).key), label: 'key' },
        items: {
          kind: 'object',
          title: 'SettingContribution',
          fields: {
            key: {
              node: {
                kind: 'string',
                min: 1,
                max: 64,
                pattern: SETTING_KEY_RE,
                patternMessage: 'must start with a letter, then letters, digits, dots, dashes or underscores.',
              },
              required: true,
              doc: 'The key its value is read under (`settings.get` in a frame, `getModuleAppState` in a worker, both with `settings:own`).',
              since: V1,
              example: 'serverUrl',
            },
            title: {
              node: displayText(64),
              required: true,
              doc: 'Its label in Settings.',
              since: V1,
              example: 'Server URL',
            },
            description: { node: displayText(512), doc: 'Help shown under the label.', since: V1 },
            type: {
              node: { kind: 'string', max: 16, enum: EXTENSION_SETTING_TYPES },
              required: true,
              doc: 'The value’s type.',
              since: V1,
            },
            default: {
              node: { kind: 'scalar', maxLength: 4096 },
              doc: 'The value read while the person has set none; of `type`.',
              since: V1,
            },
            enum: {
              node: { kind: 'array', max: 64, items: { kind: 'scalar', maxLength: 256 } },
              doc: 'The values allowed, of `type`; Settings shows a picker.',
              since: V1,
            },
            enumLabels: {
              node: { kind: 'array', max: 64, items: displayText(64) },
              doc: 'The picker’s labels, one per `enum` value.',
              since: V1,
            },
            minimum: { node: { kind: 'number' }, doc: 'Numbers: the smallest value.', since: V1 },
            maximum: { node: { kind: 'number' }, doc: 'Numbers: the largest value.', since: V1 },
            maxLength: {
              node: { kind: 'number', integer: true, min: 1, max: 4096 },
              doc: 'Strings: the most characters. Defaults to 4096.',
              since: V1,
            },
            multiline: { node: { kind: 'boolean' }, doc: 'Strings: a box of several lines.', since: V1 },
            placeholder: { node: displayText(128), doc: 'Strings and numbers: a hint shown while empty.', since: V1 },
          },
        },
      },
      doc: 'Settings Studio shows under the extension in Settings, with no code of its own; the extension’s code reads their values with `settings:own`.',
      since: V1,
      tier: 'content',
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
            inputSchema: {
              node: { kind: 'jsonSchema', maxBytes: 16_384 },
              required: true,
              doc: 'The tool’s parameters, as a JSON Schema for an object: what agents see, before the worker has ever run. The schema the worker registers must take no more than this one (no parameter it leaves out, none it requires dropped). A tool that takes none says `{ "type": "object", "properties": {} }`.',
              since: V1,
              example: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
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
      doc: 'The most authority it needs, least first: `content` (syntaxes, keybindings, status bar items, settings: data Studio draws, no approval asked), `declarative` (commands, menus, top bar items), `ui` (panels, doors, settings sections, drawn by its own code), `worker` (`main`, running in the background). Each carries what the ones below it do; a contribution above it fails validation.',
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
export type ExtensionMcpToolContribution = {
  name: string
  description: string
  access: 'read' | 'operate'
  /** The tool's parameters, as a JSON Schema for an object. */
  inputSchema: Record<string, unknown>
}

export type ExtensionSyntaxContribution = {
  id: string
  title: string
  scopeName: string
  path: string
  configuration?: string
  extensions?: string[]
  filenames?: string[]
}
export type ExtensionKeybindingContribution = { command: string; key: string; when?: 'global' | 'workspace' }
export type ExtensionStatusBarItemContribution = {
  id: string
  text?: string
  icon?: ExtensionIcon
  tooltip?: string
  command?: string
}
/** A setting's value: of its `type`. */
export type ExtensionSettingValue = string | number | boolean
export type ExtensionSettingContribution = {
  key: string
  title: string
  description?: string
  type: ExtensionSettingType
  default?: ExtensionSettingValue
  enum?: ExtensionSettingValue[]
  enumLabels?: string[]
  minimum?: number
  maximum?: number
  maxLength?: number
  multiline?: boolean
  placeholder?: string
}

export type ExtensionContributions = {
  commands: ExtensionCommandContribution[]
  menus: ExtensionMenuContribution[]
  topBarItems: ExtensionTopBarItemContribution[]
  panels: ExtensionSurfaceContribution[]
  doors: ExtensionSurfaceContribution[]
  settingsSections: ExtensionSurfaceContribution[]
  mcpTools: ExtensionMcpToolContribution[]
  syntaxes: ExtensionSyntaxContribution[]
  keybindings: ExtensionKeybindingContribution[]
  statusBarItems: ExtensionStatusBarItemContribution[]
  settings: ExtensionSettingContribution[]
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
  syntaxes: [],
  keybindings: [],
  statusBarItems: [],
  settings: [],
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
  // A keybinding or a status bar item runs a command of the extension's own,
  // or one of Studio's: a content extension binds Studio's without code.
  const runnable = (command: string) =>
    commandIds.has(command) || (EXTENSION_COMMAND_ACTIONS as readonly string[]).includes(command)
  contributes.keybindings.forEach((binding, index) => {
    if (!runnable(binding.command))
      issues.push({
        path: `contributes.keybindings[${index}].command`,
        message: `names neither a contributed command nor a Studio command action: ${binding.command}.`,
      })
  })
  contributes.statusBarItems.forEach((item, index) => {
    const path = `contributes.statusBarItems[${index}]`
    if (item.text === undefined && item.icon === undefined)
      issues.push({ path, message: 'must give text, an icon, or both.' })
    if (item.command !== undefined && !runnable(item.command))
      issues.push({
        path: `${path}.command`,
        message: `names neither a contributed command nor a Studio command action: ${item.command}.`,
      })
  })
  const scopes = new Set<string>()
  contributes.syntaxes.forEach((syntax, index) => {
    if (scopes.has(syntax.scopeName))
      issues.push({
        path: `contributes.syntaxes[${index}].scopeName`,
        message: `duplicate scope: ${syntax.scopeName}.`,
      })
    scopes.add(syntax.scopeName)
  })
  contributes.settings.forEach((setting, index) => {
    for (const problem of settingProblems(setting))
      issues.push({
        path: `contributes.settings[${index}]${problem.field ? `.${problem.field}` : ''}`,
        message: problem.message,
      })
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

/** Why `value` is not one a setting may hold, or null: its type, its choices, its range and length. */
export function settingValueProblem(setting: ExtensionSettingContribution, value: unknown): string | null {
  switch (setting.type) {
    case 'string':
      if (typeof value !== 'string') return 'must be text.'
      if (value.length > (setting.maxLength ?? 4096)) return `must be at most ${setting.maxLength ?? 4096} characters.`
      if (!setting.multiline && /[\r\n]/.test(value)) return 'must be one line.'
      break
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a number.'
      if (setting.type === 'integer' && !Number.isInteger(value)) return 'must be a whole number.'
      if (setting.minimum !== undefined && value < setting.minimum) return `must be at least ${setting.minimum}.`
      if (setting.maximum !== undefined && value > setting.maximum) return `must be at most ${setting.maximum}.`
      break
    case 'boolean':
      if (typeof value !== 'boolean') return 'must be true or false.'
      break
  }
  if (setting.enum && !setting.enum.includes(value as ExtensionSettingValue))
    return `must be one of: ${setting.enum.map((choice) => JSON.stringify(choice)).join(', ')}.`
  return null
}

function settingProblems(setting: ExtensionSettingContribution): Array<{ field?: string; message: string }> {
  const problems: Array<{ field?: string; message: string }> = []
  const numeric = setting.type === 'number' || setting.type === 'integer'
  if (!numeric && (setting.minimum !== undefined || setting.maximum !== undefined))
    problems.push({ field: 'minimum', message: 'applies to numbers only.' })
  if (setting.type !== 'string' && (setting.maxLength !== undefined || setting.multiline !== undefined))
    problems.push({ field: 'maxLength', message: 'maxLength and multiline apply to strings only.' })
  if (setting.type === 'boolean' && setting.placeholder !== undefined)
    problems.push({ field: 'placeholder', message: 'applies to strings and numbers only.' })
  if (setting.minimum !== undefined && setting.maximum !== undefined && setting.minimum > setting.maximum)
    problems.push({ field: 'minimum', message: 'must not be above maximum.' })
  if (setting.enum) {
    if (setting.type === 'boolean') problems.push({ field: 'enum', message: 'does not apply to true or false.' })
    if (setting.enum.length === 0) problems.push({ field: 'enum', message: 'must list at least one value.' })
    const bare = { ...setting, enum: undefined }
    setting.enum.forEach((choice, index) => {
      const problem = settingValueProblem(bare, choice)
      if (problem) problems.push({ field: `enum[${index}]`, message: problem })
    })
    if (new Set(setting.enum).size !== setting.enum.length)
      problems.push({ field: 'enum', message: 'lists a value twice.' })
  }
  if (setting.enumLabels && setting.enumLabels.length !== (setting.enum?.length ?? -1))
    problems.push({ field: 'enumLabels', message: 'must give one label per enum value.' })
  if (setting.default !== undefined) {
    const problem = settingValueProblem(setting, setting.default)
    if (problem) problems.push({ field: 'default', message: problem })
  }
  return problems
}

/** Each declared setting's default, by key: what is read while the person has set none. */
export function extensionSettingDefaults(
  settings: readonly ExtensionSettingContribution[],
): Record<string, ExtensionSettingValue> {
  const defaults: Record<string, ExtensionSettingValue> = {}
  for (const setting of settings) if (setting.default !== undefined) defaults[setting.key] = setting.default
  return defaults
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
