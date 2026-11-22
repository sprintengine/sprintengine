# Tally language: a content extension

A sample of what an extension adds with no code at all (`"tier": "content"`),
so it installs without an approval prompt:

- a TextMate grammar for `.tally` files, which highlights them in the editor
  and highlights a chat code block fenced as `tally`;
- a keyboard shortcut, `Mod+Alt+U`, bound to one of Studio's own commands
  (show usage);
- a status item that opens the command palette;
- two settings, shown under the extension in Settings.

Install it from this folder in Settings ▸ Extensions, or with
`sprintengine-extension pack` and then the packed folder. Studio's tests
install it the same way.

```tally
# Groceries, paid from the shared account
account Household:Shared
move 42.50 from Household:Shared to Expenses:Food on "2026-11-20"
total Expenses:Food
```
