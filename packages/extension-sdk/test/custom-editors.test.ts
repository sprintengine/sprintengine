// @vitest-environment jsdom
// Custom editors: the contribution in extension.json, which editor opens a
// file, and `studio.document` (the same source the frame runs) against the
// SDK's fake Studio, driven through the sample todo editor.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test } from 'vitest'

import { customEditorMatchRank } from '../src/custom-editors.js'
import { parseExtensionManifest, requiredExtensionTier, validateExtensionManifest } from '../src/extension-manifest.js'
import type { ExtensionEditorSession } from '../src/frame.js'
import { createFakeFrameStudio } from '../src/testing.js'

const SAMPLE = join(process.cwd(), 'packages/extension-sdk/examples/todo-editor')
const sampleManifest = JSON.parse(readFileSync(join(SAMPLE, 'extension.json'), 'utf8'))
const surface = { point: 'customEditors', id: 'todo', workspaceId: 'ws-app' } as const

function manifest(editor: Record<string, unknown>, permissions = ['workspace-files:read']) {
  return {
    manifestVersion: 1,
    id: 'sample',
    version: '1.0.0',
    engines: { studio: '>=0.13.0' },
    tier: 'ui',
    name: 'Sample',
    permissions,
    contributes: { customEditors: [{ id: 'kv', title: 'Pairs', entry: 'kv.js', ...editor }] },
  }
}

function issues(value: unknown): string[] {
  const result = validateExtensionManifest(value)
  return result.ok ? [] : result.issues.map((issue) => `${issue.path}: ${issue.message}`)
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test('the sample todo editor is a ui extension that reads and writes workspace files', () => {
  const parsed = parseExtensionManifest(readFileSync(join(SAMPLE, 'extension.json'), 'utf8'), { authoring: true })
  expect(parsed.ok ? [] : parsed.issues).toEqual([])
  if (!parsed.ok) return
  expect(requiredExtensionTier(parsed.manifest)).toBe('ui')
  expect(parsed.manifest.contributes.customEditors[0]).toMatchObject({ id: 'todo', extensions: ['.todo'] })
})

test('an editor is ui tier, names at least one file, and needs to read workspace files', () => {
  expect(issues(manifest({ extensions: ['.kv'] }))).toEqual([])
  expect(issues({ ...manifest({ extensions: ['.kv'] }), tier: 'declarative', permissions: undefined })).toContain(
    'tier: "declarative" cannot carry what this manifest declares, which needs "ui".',
  )
  expect(issues(manifest({}))).toContain('contributes.customEditors[0]: must list at least one extension or file name.')
  expect(issues(manifest({ extensions: ['.kv'] }, []))).toContain(
    'contributes.customEditors: needs the "workspace-files:read" permission.',
  )
  expect(issues(manifest({ extensions: ['kv'] }))[0]).toMatch(/suffix with its dot/)
  expect(issues(manifest({ extensions: ['.kv'], priority: 'always' }))[0]).toMatch(/priority/)
  expect(issues(manifest({ extensions: ['.kv'], contentKind: 'json' }))[0]).toMatch(/contentKind/)
})

test('an exact name beats a suffix, a longer suffix beats a shorter, and a bare suffix is no file', () => {
  const editor = { extensions: ['.json', '.todo.json'], filenames: ['TODO'] }
  expect(customEditorMatchRank(editor, 'todo')).toBeGreaterThan(customEditorMatchRank(editor, 'a.todo.json'))
  expect(customEditorMatchRank(editor, 'a.TODO.JSON')).toBeGreaterThan(customEditorMatchRank(editor, 'a.json'))
  expect(customEditorMatchRank(editor, '.json')).toBe(0)
  expect(customEditorMatchRank(editor, 'notes.md')).toBe(0)
})

async function mountSample(text: string, readOnly = false) {
  const frame = createFakeFrameStudio({ manifest: sampleManifest, document: { text, readOnly } })
  const entry = await import(join(SAMPLE, 'editor.js'))
  const root = document.createElement('div')
  document.body.append(root)
  const close = await frame.mount(entry, surface, root)
  return { frame, root, close }
}

test('the sample reads the document, sends an edit against its version, and Studio saves what it holds', async () => {
  const { frame, root, close } = await mountSample('- [ ] Buy milk\n- [x] Call the plumber\n')
  const texts = [...root.querySelectorAll<HTMLInputElement>('input[type=text]')].map((input) => input.value)
  expect(texts).toEqual(['Buy milk', 'Call the plumber'])
  root.querySelector<HTMLInputElement>('input[type=checkbox]')!.click()
  await tick()
  expect(frame.document.edits).toEqual([
    { baseVersion: 1, content: { kind: 'text', text: '- [x] Buy milk\n- [x] Call the plumber\n' } },
  ])
  expect(await frame.document.save()).toBe(true)
  expect(frame.document.text).toBe('- [x] Buy milk\n- [x] Call the plumber\n')
  expect(frame.readied).toEqual([surface])
  close()
})

test('a change from outside is drawn, and an edit made against the old version is refused and dropped', async () => {
  const { frame, root, close } = await mountSample('- [ ] Buy milk\n')
  frame.document.replace('- [ ] Buy bread\n')
  await tick()
  expect(root.querySelector<HTMLInputElement>('input[type=text]')!.value).toBe('Buy bread')

  // Typed into, then the file changes before the typing is sent: the edit
  // goes against version 2, finds version 3, and the outside version wins.
  const input = root.querySelector<HTMLInputElement>('input[type=text]')!
  input.value = 'Buy butter'
  input.dispatchEvent(new Event('input'))
  frame.document.replace('- [x] Buy bread\n')
  root.querySelector<HTMLButtonElement>('button.se-button--primary')!.click()
  await tick()
  await tick()
  expect(frame.document.refused.map((refusal) => refusal.code)).toEqual(['conflict'])
  expect(frame.document.text).toBe('- [x] Buy bread\n')
  expect(root.textContent).toMatch(/changed outside this editor/)
  close()
})

test('a session with merge resends its edit merged with the outside change', async () => {
  const frame = createFakeFrameStudio({ manifest: sampleManifest, document: { text: 'a' } })
  const studio = frame.studio(surface)
  const session: ExtensionEditorSession<string> = await studio.document!.session({
    debounceMs: 60_000,
    merge: (_base, outside, mine) => `${outside}+${mine}`,
  })
  session.change('mine')
  frame.document.replace('outside')
  await session.flush()
  expect(frame.document.text).toBe('outside+mine')
  expect(frame.document.edits.at(-1)).toEqual({ baseVersion: 2, content: { kind: 'text', text: 'outside+mine' } })
  session.dispose()
})

test('a bytes document is handed over and edited as bytes', async () => {
  const frame = createFakeFrameStudio({ manifest: sampleManifest, document: { bytes: new Uint8Array([1, 2, 3]) } })
  const session = await frame.studio(surface).document!.session<Uint8Array>({
    decode: (content) => (content.kind === 'bytes' ? new Uint8Array(content.bytes) : new Uint8Array()),
    encode: (bytes) => ({ kind: 'bytes', bytes: bytes.slice().buffer }),
  })
  expect([...session.value]).toEqual([1, 2, 3])
  session.change(new Uint8Array([9, 8]))
  await session.flush()
  expect([...frame.document.bytes!]).toEqual([9, 8])
  frame.document.replace(new Uint8Array([7]))
  await tick()
  expect([...session.value]).toEqual([7])
  session.dispose()
})

test('a read-only document takes no edit', async () => {
  const frame = createFakeFrameStudio({ manifest: sampleManifest, document: { text: 'x', readOnly: true } })
  const api = frame.studio(surface).document!
  const current = await api.get()
  expect(current.readOnly).toBe(true)
  await expect(
    api.applyEdit({ baseVersion: current.version, content: { kind: 'text', text: 'y' } }),
  ).rejects.toMatchObject({ code: 'not_permitted' })
  expect(frame.document.text).toBe('x')
})

test('only a custom editor’s frame has a document', () => {
  const frame = createFakeFrameStudio({ manifest: sampleManifest })
  expect(frame.studio({ point: 'panels', id: 'p' }).document).toBeUndefined()
})
