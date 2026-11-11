# Changelog

## 0.1.0 (unreleased)

### Added

- `ConversationView`: one Studio conversation, read-only, drawn in a shadow
  root of its own (or in the page with `isolation="none"`), themed through
  `--se-*` tokens, its rows from `@sprintengine/conversation-timeline`.
- A side question the chat was asked is drawn where it was asked, closed
  under its question, and opens to show its answer.
