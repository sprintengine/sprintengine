// What an extension's SKILL.md says to agents once Studio has copied it.
//
// A skill asks nothing at install because it is only words for agents. Its
// frontmatter could say more than words: Claude Code reads `allowed-tools`
// (tools the agent may use without asking while the skill is active) and
// `hooks` (commands run on the agent's events), and other agents read keys of
// their own. So the copy keeps only `name` and `description`, and every other
// key is dropped and listed on the install review as ignored.
//
// The copy's `name` is the namespaced one (`<publisher>.<id>.<skill id>`),
// which is also its folder's name: two extensions' `review` skills cannot
// collide, and neither can stand in for a skill of the person's own.

/** The frontmatter keys a projected skill keeps besides its name, which Studio writes. */
const KEPT_KEYS = new Set(['description'])

/** A top-level frontmatter key, as `key:` at the start of a line. */
const KEY_LINE = /^([^#:\s][^:]*?)\s*:/

type Frontmatter = { open: string; lines: string[]; rest: string; eol: string }

function frontmatterOf(text: string): Frontmatter | null {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const open = /^---[ \t]*\r?\n/.exec(body)
  if (!open) return null
  const after = body.slice(open[0].length)
  const close = /^---[ \t]*(?:\r?\n|$)/m.exec(after)
  if (!close) return null
  const inside = after.slice(0, close.index).replace(/\r?\n$/, '')
  return {
    open: open[0],
    lines: inside === '' ? [] : inside.split(/\r?\n/),
    rest: after.slice(close.index),
    eol: open[0].endsWith('\r\n') ? '\r\n' : '\n',
  }
}

/** The frontmatter keys a skill's SKILL.md holds that its projected copy drops, in the order written. */
export function ignoredSkillKeys(text: string): string[] {
  const frontmatter = frontmatterOf(text)
  if (!frontmatter) return []
  const ignored: string[] = []
  for (const line of frontmatter.lines) {
    const key = KEY_LINE.exec(line)?.[1]
    if (key === undefined || key === 'name' || KEPT_KEYS.has(key) || ignored.includes(key)) continue
    ignored.push(key)
  }
  return ignored
}

/** A skill's SKILL.md as its projected copy holds it: named `name`, with only its description kept. */
export function projectedSkillText(text: string, name: string): string {
  const frontmatter = frontmatterOf(text)
  if (!frontmatter) {
    const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
    return `---\nname: ${name}\n---\n${body}`
  }
  const kept: string[] = []
  let keep = false
  for (const line of frontmatter.lines) {
    // An indented line, a list item or a blank one goes with the key above it.
    if (!line.trim() || /^\s/.test(line) || line.startsWith('-')) {
      if (keep) kept.push(line)
      continue
    }
    const key = KEY_LINE.exec(line)?.[1]
    keep = key !== undefined && KEPT_KEYS.has(key)
    if (keep) kept.push(line)
  }
  const { eol } = frontmatter
  return `${frontmatter.open}name: ${name}${eol}${kept.map((line) => `${line}${eol}`).join('')}${frontmatter.rest}`
}
