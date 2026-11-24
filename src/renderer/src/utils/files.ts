import { contributedSyntaxForFile } from '../lib/highlight/contributedSyntaxes'

const IMAGE_EXTENSIONS = new Set(['apng', 'avif', 'bmp', 'gif', 'ico', 'jpeg', 'jpg', 'png', 'svg', 'webp'])

function fileExtension(filename: string): string {
  return filename.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase() ?? ''
}

export function isImageFile(filename: string): boolean {
  return IMAGE_EXTENSIONS.has(fileExtension(filename))
}

/**
 * The editor's language for a file: Studio's own for every suffix it knows,
 * else one an extension contributes that claims the file's name or suffix
 * (contributedSyntaxes.ts). An extension adds languages; it never replaces
 * one of Studio's.
 */
export function detectLanguage(filename: string): string {
  const builtin = builtinLanguage(filename)
  if (builtin !== 'plaintext') return builtin
  return contributedSyntaxForFile(filename)?.language ?? builtin
}

/**
 * Whether Studio's own editor is for a file: it has a language for it (one
 * of Studio's, or one another extension contributes) or shows it as an
 * image. An extension's custom editor for such a file is only offered, never
 * opened by default. `exceptExtension` leaves out the syntaxes of the
 * extension asking, whose own language does not stand in its own way.
 */
export function textEditorHandles(filename: string, exceptExtension?: string): boolean {
  if (isImageFile(filename) || builtinLanguage(filename) !== 'plaintext') return true
  const contributed = contributedSyntaxForFile(filename)
  return contributed !== undefined && contributed.extensionId !== exceptExtension
}

function builtinLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    cs: 'csharp',
    cpp: 'cpp',
    c: 'c',
    h: 'c',
    rb: 'ruby',
    php: 'php',
    html: 'html',
    css: 'css',
    scss: 'scss',
    json: 'json',
    md: 'markdown',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'ini',
    sh: 'shell',
    bash: 'shell',
    sql: 'sql',
    xml: 'xml',
    patch: 'patch',
    diff: 'patch',
  }
  return map[ext] ?? 'plaintext'
}
