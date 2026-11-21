// A small schema vocabulary for extension.json: one description of each field
// drives the validator, the JSON Schema and the reference in the guide. The
// JSON Schema carries each field's shape (and what a pattern can say of a
// path); the SDK's validator is authoritative for the rest. The repository keeps no schema library, so this is
// the least that does the job: strings, booleans, one literal, arrays and
// strict objects. Pure (no Node or DOM APIs).

export type ManifestIssue = { path: string; message: string }

/** Who may carry a field or a contribution point, least first. */
export const EXTENSION_TIERS = ['content', 'declarative', 'ui', 'worker'] as const
export type ExtensionTier = (typeof EXTENSION_TIERS)[number]

export function tierRank(tier: ExtensionTier): number {
  return EXTENSION_TIERS.indexOf(tier)
}

export type StringNode = {
  kind: 'string'
  min?: number
  max: number
  pattern?: RegExp
  /** What a value that fails `pattern` is told. */
  patternMessage?: string
  enum?: readonly string[]
  /** Extra checks a pattern cannot express; returns a message, or null. */
  check?: (value: string) => string | null
  /** A pattern for the JSON Schema alone, approximating what `check` holds. */
  schemaPattern?: string
}
export type BooleanNode = { kind: 'boolean' }
export type LiteralNode = { kind: 'literal'; value: number }
export type ArrayNode = {
  kind: 'array'
  items: SchemaNode
  max: number
  /** Duplicates by this key are refused; the label names the key. */
  unique?: { key: (item: unknown) => string; label: string }
}
export type ObjectNode = { kind: 'object'; fields: Readonly<Record<string, FieldSpec>>; title?: string }
/** A key held for a later format: present, it must be an empty array. */
export type ReservedNode = { kind: 'reserved'; purpose: string }
/** A JSON Schema for an object (a tool's parameters): JSON data, `type: "object"`, at most `maxBytes` as JSON. */
export type JsonSchemaNode = { kind: 'jsonSchema'; maxBytes: number }

export type SchemaNode = StringNode | BooleanNode | LiteralNode | ArrayNode | ObjectNode | ReservedNode | JsonSchemaNode

/** Why `value` is not plain JSON data (objects, lists, strings, finite numbers, booleans, null), or null. */
function jsonDataProblem(value: unknown, depth = 0): string | null {
  if (depth > 32) return 'nests too deep.'
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return null
  if (typeof value === 'number') return Number.isFinite(value) ? null : 'holds a number JSON cannot carry.'
  if (Array.isArray(value)) {
    for (const item of value) {
      const problem = jsonDataProblem(item, depth + 1)
      if (problem) return problem
    }
    return null
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) return `holds the reserved name "${key}".`
      const problem = jsonDataProblem(item, depth + 1)
      if (problem) return problem
    }
    return null
  }
  return 'holds something that is not JSON.'
}

export type FieldSpec = {
  node: SchemaNode
  required?: boolean
  /** One or two sentences for the reference. */
  doc: string
  /** The first Studio that reads the field (`x.y.z`). */
  since: string
  /** The least tier that may carry the field when it is set (a non-empty list, for a point). */
  tier?: ExtensionTier
  example?: unknown
  /** Left out of the validated result (`$schema`). */
  ignored?: boolean
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function join(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`
  return path ? `${path}.${key}` : key
}

/** Validate `value` against `node`; issues are appended, and the cleaned value is returned. */
export function validateNode(node: SchemaNode, value: unknown, path: string, issues: ManifestIssue[]): unknown {
  switch (node.kind) {
    case 'string': {
      if (typeof value !== 'string') {
        issues.push({ path, message: 'must be a string.' })
        return undefined
      }
      if (value.length < (node.min ?? 0)) {
        issues.push({
          path,
          message: node.min === 1 ? 'must not be empty.' : `must be at least ${node.min} characters.`,
        })
        return undefined
      }
      if (value.length > node.max) {
        issues.push({ path, message: `must be at most ${node.max} characters.` })
        return undefined
      }
      if (node.enum && !node.enum.includes(value)) {
        issues.push({ path, message: `must be one of: ${node.enum.join(', ')}.` })
        return undefined
      }
      if (node.pattern && !node.pattern.test(value)) {
        issues.push({ path, message: node.patternMessage ?? `must match ${node.pattern.source}.` })
        return undefined
      }
      const problem = node.check?.(value)
      if (problem) {
        issues.push({ path, message: problem })
        return undefined
      }
      return value
    }
    case 'boolean':
      if (typeof value !== 'boolean') {
        issues.push({ path, message: 'must be true or false.' })
        return undefined
      }
      return value
    case 'literal':
      if (value !== node.value) {
        issues.push({ path, message: `must be ${node.value}.` })
        return undefined
      }
      return value
    case 'reserved':
      if (!Array.isArray(value) || value.length > 0) {
        issues.push({ path, message: `is reserved for ${node.purpose} and must be empty for now.` })
      }
      return undefined
    case 'jsonSchema': {
      if (!isPlainObject(value)) {
        issues.push({ path, message: 'must be a JSON Schema object.' })
        return undefined
      }
      const problem = jsonDataProblem(value)
      if (problem) {
        issues.push({ path, message: `must be JSON data: it ${problem}` })
        return undefined
      }
      if (value.type !== 'object') {
        issues.push({ path, message: 'must describe an object: `"type": "object"`.' })
        return undefined
      }
      if (value.properties !== undefined && !isPlainObject(value.properties)) {
        issues.push({ path: join(path, 'properties'), message: 'must be an object of property name to schema.' })
        return undefined
      }
      if (
        value.required !== undefined &&
        (!Array.isArray(value.required) || value.required.some((name) => typeof name !== 'string'))
      ) {
        issues.push({ path: join(path, 'required'), message: 'must be a list of property names.' })
        return undefined
      }
      if (JSON.stringify(value).length > node.maxBytes) {
        issues.push({ path, message: `must be at most ${node.maxBytes} characters as JSON.` })
        return undefined
      }
      return JSON.parse(JSON.stringify(value)) as unknown
    }
    case 'array': {
      if (!Array.isArray(value)) {
        issues.push({ path, message: 'must be an array.' })
        return undefined
      }
      if (value.length > node.max) {
        issues.push({ path, message: `may hold at most ${node.max} entries.` })
        return undefined
      }
      const out: unknown[] = []
      const seen = new Set<string>()
      value.forEach((item, index) => {
        const before = issues.length
        const cleaned = validateNode(node.items, item, join(path, index), issues)
        if (issues.length > before) return
        if (node.unique) {
          const key = node.unique.key(cleaned)
          if (seen.has(key)) {
            issues.push({ path: join(path, index), message: `duplicate ${node.unique.label}: ${key}.` })
            return
          }
          seen.add(key)
        }
        out.push(cleaned)
      })
      return out
    }
    case 'object': {
      if (!isPlainObject(value)) {
        issues.push({ path, message: 'must be an object.' })
        return undefined
      }
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(value)) {
        if (FORBIDDEN_KEYS.has(key)) {
          issues.push({ path: join(path, key), message: 'is a reserved name.' })
        } else if (!Object.hasOwn(node.fields, key)) {
          issues.push({ path: join(path, key), message: 'is not a field Studio knows.' })
        }
      }
      for (const [key, field] of Object.entries(node.fields)) {
        const present = Object.hasOwn(value, key) && value[key] !== undefined
        if (!present) {
          if (field.required) issues.push({ path: join(path, key), message: 'is required.' })
          continue
        }
        const cleaned = validateNode(field.node, value[key], join(path, key), issues)
        if (cleaned !== undefined && !field.ignored) out[key] = cleaned
      }
      return out
    }
  }
}

// ── JSON Schema ─────────────────────────────────────────────────────────────

export type JsonSchema = { [key: string]: unknown }

export function nodeJsonSchema(node: SchemaNode, field?: FieldSpec): JsonSchema {
  const meta: JsonSchema = {}
  if (field) {
    meta.description = field.doc
    meta['x-since'] = field.since
    if (field.tier) meta['x-tier'] = field.tier
    if (field.example !== undefined) meta.examples = [field.example]
  }
  switch (node.kind) {
    case 'string':
      return {
        type: 'string',
        ...(node.min ? { minLength: node.min } : {}),
        maxLength: node.max,
        ...(node.pattern
          ? { pattern: node.pattern.source }
          : node.schemaPattern
            ? { pattern: node.schemaPattern }
            : {}),
        ...(node.enum ? { enum: [...node.enum] } : {}),
        ...meta,
      }
    case 'boolean':
      return { type: 'boolean', ...meta }
    case 'literal':
      return { const: node.value, ...meta }
    case 'reserved':
      return { type: 'array', maxItems: 0, ...meta, description: `Reserved for ${node.purpose}; must be empty.` }
    case 'jsonSchema':
      return { type: 'object', required: ['type'], properties: { type: { const: 'object' } }, ...meta }
    case 'array':
      return { type: 'array', maxItems: node.max, items: nodeJsonSchema(node.items), ...meta }
    case 'object': {
      const properties: Record<string, JsonSchema> = {}
      const required: string[] = []
      for (const [key, child] of Object.entries(node.fields)) {
        properties[key] = nodeJsonSchema(child.node, child)
        if (child.required) required.push(key)
      }
      return {
        type: 'object',
        ...(node.title ? { title: node.title } : {}),
        additionalProperties: false,
        properties,
        ...(required.length > 0 ? { required } : {}),
        ...meta,
      }
    }
  }
}

// ── Reference rows ──────────────────────────────────────────────────────────

export type ReferenceRow = {
  path: string
  type: string
  required: boolean
  since: string
  tier?: ExtensionTier
  doc: string
}

function typeText(node: SchemaNode): string {
  switch (node.kind) {
    case 'string':
      return node.enum ? node.enum.map((value) => `\`${value}\``).join(' \\| ') : 'string'
    case 'boolean':
      return 'boolean'
    case 'literal':
      return `\`${node.value}\``
    case 'reserved':
      return 'reserved, `[]`'
    case 'jsonSchema':
      return 'JSON Schema object'
    case 'array':
      return `${node.items.kind === 'object' ? 'object' : typeText(node.items)}[] (at most ${node.max})`
    case 'object':
      return 'object'
  }
}

/** Every field, depth first, as the reference table lists them. */
export function referenceRows(node: ObjectNode, prefix = ''): ReferenceRow[] {
  const rows: ReferenceRow[] = []
  for (const [key, field] of Object.entries(node.fields)) {
    const path = prefix ? `${prefix}.${key}` : key
    rows.push({
      path,
      type: typeText(field.node),
      required: field.required === true,
      since: field.since,
      ...(field.tier ? { tier: field.tier } : {}),
      doc: field.doc,
    })
    const child = field.node.kind === 'array' ? field.node.items : field.node
    if (child.kind === 'object') rows.push(...referenceRows(child, field.node.kind === 'array' ? `${path}[]` : path))
  }
  return rows
}
