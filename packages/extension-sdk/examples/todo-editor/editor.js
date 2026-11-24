// A custom editor for .todo files: one task a line, `- [ ] text` or
// `- [x] text`. It draws them as a form (tick, edit, remove, add) and keeps
// the file in step with `studio.document.session()`: each change is sent to
// Studio as a whole-document edit, Studio holds the unsaved state and saves
// (Cmd/Ctrl+S here, or Save in the editor's bar), and a change made outside
// (on disk, or in Studio's text editor) is drawn as it arrives.
//
// Plain JavaScript with no build: the entry is this file.

/** The tasks a .todo file holds. A line that is not a task is kept as a task's text. */
export function parseTodos(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const match = /^\s*-\s*\[( |x|X)\]\s?(.*)$/.exec(line)
      return match ? { done: match[1] !== ' ', text: match[2] } : { done: false, text: line.trim() }
    })
}

/** The file's text for a list of tasks. */
export function formatTodos(tasks) {
  return tasks.map((task) => `- [${task.done ? 'x' : ' '}] ${task.text}`).join('\n') + (tasks.length ? '\n' : '')
}

const STYLE = `
.todo{padding:12px 16px;max-width:640px}
.todo__row{display:flex;align-items:center;gap:8px;padding:4px 0}
.todo__row input[type=text]{flex:1}
.todo__done input[type=text]{text-decoration:line-through;color:var(--text-muted)}
.todo__bar{display:flex;gap:8px;align-items:center;margin-top:8px}
.todo__note{margin-top:8px}
`

export async function mount(root, studio) {
  const doc = root.ownerDocument
  const style = doc.createElement('style')
  style.textContent = STYLE
  doc.head.append(style)

  const session = await studio.document.session({
    decode: (content) => parseTodos(content.kind === 'text' ? content.text : ''),
    encode: (tasks) => ({ kind: 'text', text: formatTodos(tasks) }),
  })

  const box = doc.createElement('div')
  box.className = 'todo'
  root.replaceChildren(box)
  let note = ''

  // A tick, an add or a remove is sent at once; typing waits for a pause.
  const change = (tasks) => {
    note = ''
    session.change(tasks)
    draw()
    session.flush().catch(refused)
  }

  function draw() {
    const tasks = session.value
    const rows = tasks.map((task, index) => {
      const row = doc.createElement('div')
      row.className = task.done ? 'todo__row todo__done' : 'todo__row'
      const tick = doc.createElement('input')
      tick.type = 'checkbox'
      tick.checked = task.done
      tick.disabled = session.readOnly
      tick.setAttribute('aria-label', `Done: ${task.text}`)
      tick.addEventListener('change', () =>
        change(tasks.map((t, i) => (i === index ? { ...t, done: tick.checked } : t))),
      )
      const text = doc.createElement('input')
      text.type = 'text'
      text.className = 'se-input'
      text.value = task.text
      text.readOnly = session.readOnly
      text.setAttribute('aria-label', 'Task')
      text.addEventListener('input', () => {
        note = ''
        session.change(session.value.map((t, i) => (i === index ? { ...t, text: text.value } : t)))
      })
      const remove = doc.createElement('button')
      remove.className = 'se-button'
      remove.textContent = 'Remove'
      remove.disabled = session.readOnly
      remove.addEventListener('click', () => change(tasks.filter((_, i) => i !== index)))
      row.append(tick, text, remove)
      return row
    })
    const bar = doc.createElement('div')
    bar.className = 'todo__bar'
    const add = doc.createElement('button')
    add.className = 'se-button se-button--primary'
    add.textContent = 'Add a task'
    add.disabled = session.readOnly
    add.addEventListener('click', () => {
      change([...session.value, { done: false, text: '' }])
      const inputs = box.querySelectorAll('input[type=text]')
      inputs[inputs.length - 1]?.focus()
    })
    const count = doc.createElement('span')
    count.className = 'se-muted'
    const open = tasks.filter((task) => !task.done).length
    count.textContent = `${open} of ${tasks.length} open${session.readOnly ? ' · read only' : ''}`
    bar.append(add, count)
    const children = [...rows, bar]
    if (note) {
      const line = doc.createElement('p')
      line.className = 'se-muted todo__note'
      line.setAttribute('role', 'status')
      line.textContent = note
      children.push(line)
    }
    box.replaceChildren(...children)
  }

  // Changed outside: on disk, in the text editor, or an edit refused because
  // the file changed first (the outside version wins, and says so).
  const replaced = session.onReplace(() => draw())
  function refused(error) {
    if (error && error.code === 'conflict') {
      note = 'The file changed outside this editor, so your last change was not applied.'
      draw()
    }
  }

  draw()
  studio.ready()
  return () => {
    replaced.dispose()
    session.dispose()
    style.remove()
  }
}
