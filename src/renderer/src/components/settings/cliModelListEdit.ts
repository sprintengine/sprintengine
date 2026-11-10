// The rules for editing one CLI's model list in Settings ▸ Agents, apart from
// the component so the table of cases can be pinned without a DOM.
//
// Two stored lists make up an edit, both on the CLI's runtime settings:
//
//   models         the ids the person typed
//   removedModels  the ids the person took off what the CLI reports
//
// They are separate because the CLI's own list is replaced on every refresh. A
// typed id has to survive that replacement, and so does the fact that a
// reported id was removed.

export type CliModelEdit = { models: string[]; removedModels: string[] }

// The wire drops an id past this length rather than cutting it, because a
// shortened id is a different model (conversation-model-catalog.ts).
const MAX_MODEL_ID_CHARS = 200

export type TypedModelResult =
  { ok: true; id: string; edit: CliModelEdit; restored: boolean } | { ok: false; reason: string }

/**
 * What typing `raw` into the add field does to the list. An id the person
 * removed earlier is put back as the CLI's own row, label and all, rather than
 * stored a second time as a typed copy.
 */
export function addTypedModel(
  raw: string,
  edit: CliModelEdit,
  listedIds: ReadonlySet<string>,
  displayName: string,
): TypedModelResult {
  const id = raw.trim()
  if (!id) return { ok: false, reason: 'Type a model id first.' }
  if (/\s/.test(id)) return { ok: false, reason: 'A model id has no spaces in it.' }
  // It is passed as the value of `--model`, where a leading dash reads as a flag.
  if (id.startsWith('-')) return { ok: false, reason: 'A model id cannot start with a dash.' }
  if (id.length > MAX_MODEL_ID_CHARS) {
    return { ok: false, reason: `A model id is at most ${MAX_MODEL_ID_CHARS} characters.` }
  }
  if (listedIds.has(id)) return { ok: false, reason: `${id} is already in ${displayName}'s list.` }
  if (edit.removedModels.includes(id)) {
    return { ok: true, id, restored: true, edit: restoreListedModel(edit, id) }
  }
  return { ok: true, id, restored: false, edit: { ...edit, models: [...edit.models, id] } }
}

/**
 * Take `id` off the list. An id the CLI or the seed reports is remembered as
 * removed, or the next refresh would bring it straight back; one only the
 * person typed just goes.
 */
export function removeListedModel(edit: CliModelEdit, id: string, reportedIds: ReadonlySet<string>): CliModelEdit {
  return {
    models: edit.models.filter((model) => model !== id),
    removedModels:
      reportedIds.has(id) && !edit.removedModels.includes(id) ? [...edit.removedModels, id] : edit.removedModels,
  }
}

/** Put a removed id back on the list. */
export function restoreListedModel(edit: CliModelEdit, id: string): CliModelEdit {
  return { ...edit, removedModels: edit.removedModels.filter((model) => model !== id) }
}
