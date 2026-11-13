# Changelog

## 0.1.0 (unreleased)

### Changed (contract)

- `PromptCacheReading`, the mention and attached-file readers are
  `@sprintengine/conversation-protocol`'s, re-exported here unchanged. This
  package then needs the protocol release that adds them: raise its
  `@sprintengine/conversation-protocol` range when the two are published.

### Changed

- `formatStepDuration` moves up to hours from an hour on ("6h 59m 50s"),
  where it read "419m 50s".

- `retryLabel` reads a 403 as "Access refused", where it read "Couldn’t
  authenticate", whatever category the provider filed it under.

### Added

- **`deriveConversationRows`** (`conversationRows.ts`): a projected
  conversation as one flat list of rows for a narrow screen (messages,
  thinking, runs of steps, agent cards, each turn's work behind one line, its
  footer and changed files), with the requests waiting, the agents, the turns'
  clocks and the changed turns beside them. `ConversationRowsOptions` holds
  what a client draws its own way (its clock, steps kept in view, its reading
  of a sent picture and of Studio's notices). The phone draws it.
- `projectConversation(events, userTurns, options)`:
  `ConversationProjectionOptions.sessionEndSettlesWork` settles a session's
  work when it ends (turns stop streaming, steps and agents stop, requests are
  cancelled). Off by default; `createConversationProjectionState` takes the
  same options and keeps them for every refold.
- A user entry's `commandId`; an assistant entry's `reportedChanges` (the
  files its finished steps reported changing, `fileChanges`); an approval
  entry's `rememberable` and `rememberLabel`.

### Changed (reading the events)

- An event that names no turn (`content_delta`, `reasoning_delta`,
  `tool_started` outside a lane, `approval_requested`) joins the turn running
  when it came, where it was dropped or left on its own. A `user_message` that
  names none waits for the next turn to begin, which answers it.
- A `tool_started` sent again for a call updates the one call: a call that
  already finished stays finished, with its output, and what the new report
  leaves out (its input) is what the call had.
- A recorded picture without a `mediaType` is still listed (its type `''`);
  the bytes read back by `ref` carry their own.

- `SideQuestionEntry` (`kind: 'sideQuestion'`) and the timeline row of the same
  kind: a side question the chat was asked, read from its `side_question`
  event, with the answer it got. It sits after the turn it was asked during or
  after, never inside a turn.
- A lane carries `sent`, what the person wrote to its agent, and its agent state
  `canContinue`. A user entry carries `subagentMessage`. `laneTranscript` reads a
  lane as a conversation of its own for the timeline to draw, and
  `collectAgentLanes`, `directAgentLanes`, `childAgentLanes`, `placeAgentMessages`
  and `lanePrompt` are exported.

- `stepShownToUser` also holds Studio's `plugin.offer` out of a turn's fold,
  so the plugin card it draws stands under the turn as a generated picture
  does. `isPluginOffer` recognises the call under any runtime's spelling.

- The projection carries a `handoff` entry, and the timeline a `handoff` row,
  for a `context_handed_off` event: the chat was handed off to a fresh session
  pointed at a file of its messages (`path`), leaving `preTokens` of context
  behind. It sits after the turn it followed, as a compaction between turns
  does, and resets the prompt-cache reading and the context's size, as a
  compaction does.

- A compaction entry says `beforeCacheExpiry` when its turn's message was
  Studio's own `/compact` before the chat's prompt cache expired (`origin`
  reason `auto-compact`), and the timeline draws no row for that message: the
  compaction's divider says it.

- The projection carries `goal`: the goal the session's agent keeps working
  toward by itself (`objective`, `status`), as the latest `session_updated`
  that named one said it, null once one says `goal: null`, and emptied when a
  session starts. `readConversationGoal` is the reader, and
  `CONVERSATION_GOAL_STATUS_WORDS` says each status in a word or two
  ("Working", "Paused", "Met").

- The projection carries `backgroundTasks`: the shells, monitors and workflows
  the session's process still runs after its turn ended, as the latest
  `session_updated` listed them, emptied when a session starts.
  `readBackgroundTasks` is the reader, `backgroundTasksWakeAgent` says whether
  any will wake the agent (a monitor with a deadline or a task does; a command
  does not), and `describeBackgroundTasks` names them in one line ("Waiting on
  monitor: CI checks", "Running: npm run dev").

- A tool entry carries `images`, the pictures its step returned, read from
  a `tool_output`'s `images` member (paths that are text, at most eight,
  `MAX_TOOL_IMAGES`) by `readImagePaths`. The full and the incremental
  projection read it alike; a step that returned none has no member.

- The working row carries `latestThought`, the first sentence of the newest
  thinking or prose between the running turn's steps, and the `turnId` whose
  fold it sits under, so a view can say why the agent is doing what the line
  says while those steps are folded. Absent while the agent replies.
  `reasoningPreview`, `firstThoughtSentence` and `latestTurnThought` are the
  readers.

- A user entry carries `files`, the files the message attached by path, read
  from a `user_message`'s `files` member (`{ path }` each), and a local turn
  passes its own through. `parseConversationAttachedFiles` is the reader and
  `attachedFileName` names one; a view draws a message's file cards from this
  list, never from its text.

- A user entry carries the `origin` its `user_message` recorded, for a message
  the desktop sent the chat itself, so a view can draw it as Studio's rather
  than as the person's.

- `ConversationUsage` carries `contextWindow` and `contextUsed` from
  `usage_updated`, each kept until a report moves it (a compaction resets
  `contextUsed` to what the summary left). `nextConversationUsage` is the fold,
  shared by the full and the incremental projection.

- The projection, incremental projection and timeline Studio's chat view
  draws from, moved here unchanged so the app and other views share one
  implementation.
- `createConversationFollower`: follow one conversation over a Studio
  connection and read it as rows, with paging to earlier turns.
- `checkConversationTimelineProtocol`: the conversation protocol window the
  package reads, checked against a Studio's welcome.
- `turn_retrying` is read: the turn's entry carries the latest `retry`
  until the turn reports anything else, and the working row says why and
  which attempt (`retryLabel`), in place of "Thinking…".
