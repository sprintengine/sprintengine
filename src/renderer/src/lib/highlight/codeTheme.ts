import type { ThemeRegistrationRaw } from 'shiki/core'

// The one theme every code block and every contributed grammar is tokenized
// in: each colour a `--sem-syntax-*` role, so a theme change needs no new
// pass and a token's role can be read back from its colour.

export const CODE_THEME = 'semantic-code'

export const CODE_THEME_REGISTRATION: ThemeRegistrationRaw = {
  name: CODE_THEME,
  fg: 'var(--sem-syntax-foreground)',
  bg: 'var(--sem-color-bg-surface-raised)',
  settings: [
    { scope: 'comment', settings: { foreground: 'var(--sem-syntax-comment)' } },
    { scope: ['keyword', 'storage'], settings: { foreground: 'var(--sem-syntax-keyword)' } },
    { scope: 'string', settings: { foreground: 'var(--sem-syntax-string)' } },
    { scope: ['constant.numeric', 'constant.language'], settings: { foreground: 'var(--sem-syntax-number)' } },
    { scope: ['entity.name.function', 'support.function'], settings: { foreground: 'var(--sem-syntax-function)' } },
    { scope: ['entity.name.type', 'support.type'], settings: { foreground: 'var(--sem-syntax-type)' } },
  ],
}

/** The code colours, in the order a semantic-token legend lists them. */
export const CODE_ROLES = ['comment', 'keyword', 'string', 'number', 'function', 'type'] as const
export type CodeRole = (typeof CODE_ROLES)[number]

/** A token's role, read from its colour in the code theme; null for the plain foreground. */
export function codeRoleOfColor(color: string | undefined): CodeRole | null {
  const role = color ? /^var\(--sem-syntax-([a-z]+)\)$/.exec(color)?.[1] : undefined
  return role && (CODE_ROLES as readonly string[]).includes(role) ? (role as CodeRole) : null
}

/** The colour the code theme gives a role. */
export function colorOfCodeRole(role: CodeRole): string {
  return `var(--sem-syntax-${role})`
}
