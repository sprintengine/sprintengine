// A form: an Input, a Select and a Switch, with Studio owning what the person
// types. The draft is a keyed memory atom, so a save in a development folder
// hands it to the reloaded panel and half-typed text survives the reload.
// What is sent is kept for this run only.

import {
  atom,
  read,
  set,
  update,
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  List,
  ListItem,
  Row,
  Select,
  Separator,
  Stack,
  Switch,
} from '@sprintengine/extension-sdk/components'

type Kind = 'bug' | 'idea' | 'question'
type Draft = { title: string; kind: Kind; urgent: boolean }
type Request = Draft & { id: number }

const KINDS: Array<{ value: Kind; label: string }> = [
  { value: 'bug', label: 'Bug' },
  { value: 'idea', label: 'Idea' },
  { value: 'question', label: 'Question' },
]

const EMPTY: Draft = { title: '', kind: 'bug', urgent: false }

const draft = atom<Draft>('form.draft', EMPTY)
const sent = atom<Request[]>('form.sent', [])

function edit(change: Partial<Draft>): void {
  update(draft, (now) => ({ ...now, ...change }))
}

function send(): void {
  const now = read(draft)
  const title = now.title.trim()
  if (!title) return
  update(sent, (list) => [...list, { ...now, title, id: list.length + 1 }])
  set(draft, EMPTY)
}

function kindLabel(kind: Kind): string {
  return KINDS.find((each) => each.value === kind)?.label ?? kind
}

export default function RequestForm() {
  const now = read(draft)
  const list = read(sent)
  const missing = now.title.trim() === ''
  return (
    <Stack gap="md">
      <Field label="Title" description="One line: what happened, or what you would like." required>
        <Input
          label="Title"
          labelHidden
          placeholder="The export button does nothing"
          value={now.title}
          maxLength={120}
          onChange={(title) => edit({ title })}
          onSubmit={send}
        />
      </Field>
      <Select label="Kind" value={now.kind} options={KINDS} onChange={(kind) => edit({ kind: kind as Kind })} />
      <Switch label="Urgent" checked={now.urgent} onChange={(urgent) => edit({ urgent })} />
      <Row justify="end">
        <Button variant="solid" tone="accent" disabled={missing} onPress={send}>
          Send
        </Button>
      </Row>
      <Separator />
      {list.length === 0 ? (
        <EmptyState title="Nothing sent yet" description="What you send shows here." icon="chat" />
      ) : (
        <List label="Sent">
          {list.map((request) => (
            <ListItem key={request.id} title={request.title} description={kindLabel(request.kind)}>
              {request.urgent ? <Badge tone="warning">Urgent</Badge> : null}
            </ListItem>
          ))}
        </List>
      )}
    </Stack>
  )
}
