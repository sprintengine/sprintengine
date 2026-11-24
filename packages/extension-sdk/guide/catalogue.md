# The extension catalogue

Studio lists extensions people can install from catalogues: JSON files that
name each extension, where its source lives and the exact releases they vouch
for. Settings → Extensions → Browse shows them.

- **Official**: Studio's own catalogue. Its extensions carry the Official
  label, and only it may list the reserved publishers and ids.
- **Community**: the community catalogue. Each extension carries the label
  Community · its owner. It is there from the start; the person can remove
  it, and add it back.
- **Catalogues you add**: any git repository holding a `catalogue.json` at its
  root, read at its `main` branch. Studio asks before it adds one. Their
  extensions carry the catalogue's name and the owner in its git URL.

The official and community catalogues, the owner records, the release lock
and the kill list are read over HTTPS from Studio's catalogue repository.

## Listing an extension

1. Commit the extension's folder (`extension.json` and every file it ships)
   in a public git repository. One repository can hold many extensions, each in
   a folder of its own.
2. Run `npx sprintengine-extension release-entry <folder>`. It writes the
   folder out from the committed HEAD exactly as Studio installs it, and prints
   the release entry: the commit, the content hash Studio checks, the tier, the
   Studio it needs, its permissions and its contributions. It also prints the
   folder's path in the repository, for the entry's `source.path`, and the id
   the extension is listed under.
3. Add the entry to the catalogue, newest release first, and keep earlier
   releases listed when a new one raises `engines.studio`.

```json
{
  "id": "acme.notes",
  "source": { "url": "https://github.com/acme/studio-extensions.git", "ref": "main", "path": "notes" },
  "releases": [{ "version": "1.2.0", "commit": "…", "contentHash": "…", "tier": "ui", "minimumStudio": "0.13.0", "permissions": [], "contributes": [{ "kind": "panels", "name": "notes" }] }]
}
```

## What Studio checks at install

- It checks out the release's `commit` and installs only the extension's
  folder (`source.path`).
- It refuses bytes whose content hash is not the release's `contentHash`, and
  an `extension.json` whose version, tier, `engines.studio`, permissions or
  contributions are not what the release lists.
- **The publisher is the repository owner.** An entry's `id` is
  `<owner>.<id>`, the owner lowercased. On a host other than github.com the
  publisher is marked and carries the host (`gitlab.com/alice/notes` is
  `from-gitlab-com-alice.notes`), so an owner of the same name elsewhere
  cannot pass for a GitHub one. The mark is kept for other hosts: a GitHub
  owner whose name begins `from-` cannot publish under it, so no GitHub
  account can take another host's publisher either. A git URL
  install takes the URL's owner, and every catalogue, an added one included,
  must list an extension under its repository's owner; a folder is `local`. `sprintengine`, `official`, `local` and any publisher
  starting `studio` are reserved, as are ids starting `studio-` or
  `sprintengine-`: they install only from the official catalogue, and any other
  catalogue that lists one is refused whole.
- **A listed version never moves.** The first time Studio sees a version in
  the catalogue an extension was installed from, it records its commit and
  content hash, and the catalogue's release lock does the same. A catalogue
  re-pointing a version is refused: publish a new version instead. Removing
  the extension forgets what this Studio recorded for it. A git URL install
  is the person's own choice of commit, so it is held only to the
  catalogue's release lock.
- **An install stays with its source.** Studio records where each extension
  came from (a catalogue, or a git URL's repository and folder) and updates
  it only from there. Installing it from another catalogue, another kind of
  source or another repository or folder means removing it first.
- **What installs is what was checked.** An install names the whole release
  the person was shown (its version, commit, content hash, source and
  owner), and an update the release that was checked and held back. A
  catalogue that lists anything else by the time it installs is refused.
- **Owners are pinned.** Studio records the owner's numeric id at the first
  install. When the owner is renamed or the repository changes hands, or
  Studio cannot tell who owns it now, updates pause until the extension is
  installed again (or, for the last, until Studio can tell).

## Updates

Studio checks for updates periodically. It installs the newest release whose
`minimumStudio` it meets:

- quietly, with a notice, when the update asks for no more access;
- not at all when it asks for more (a permission, a higher tier, `background`,
  a local MCP server's command, a provider's origin) or moved to another
  repository or folder: it waits in Settings for the person to review, with a
  notice.

A release a community or added catalogue lists is installed on its own only
once it has been listed for 12 hours, so a takedown has time to land. An
extension the person switched off is not updated on its own.

## The kill list

An extension, or some of its versions, that turns out harmful is put on the
kill list. Studio reads the list periodically; a killed version is switched
off, everything it added (surfaces, tools, skills, MCP servers, providers) is
retracted, and Settings says why. Studio reads the list again before every
install and update, and a killed version cannot be installed. Without a list
read now, an install uses the copy Studio kept; with none kept, nothing
installs.

## Listing policy

A catalogue lists an extension for everyone who reads it, so Studio's
catalogues hold every listing to these rules:

- **Free to use.** A listed extension installs and runs without payment. It
  may connect to a paid service the person already uses.
- **The publisher is the owner.** An extension is listed under the account
  that owns its repository, and nobody else's.
- **No impersonation.** A name, icon or description must not pass the
  extension off as Studio's own, or as another publisher's.
- **No tracking.** An extension sends nothing about the person or their work
  anywhere they did not ask it to, and says what it sends.
- **No concealed code.** What runs is in the listed commit, readable:
  nothing minified past reading, obfuscated, or fetched and run later.
- **No explicit content.** Listings and what extensions show are fit for a
  workplace.
- **Reports and removal.** Report a listing that breaks a rule by opening an
  issue on the catalogue repository. A listing that breaks one is removed,
  and one that harms people who installed it is put on the kill list.

## Install links

An install link opens an extension's page in Settings → Extensions. It never
installs: the person reads the page and presses Install.

```text
sprintengine://extensions/<publisher>.<id>?catalog=<official | community | git URL>
```

`catalog` defaults to `official`. A git URL of a catalogue the person has not
added asks first.

## Reference

<!-- generated:extension-catalogue-reference:start -->

### catalogue.json

| Field | Type | Required | Since | Description |
|---|---|---|---|---|
| `$schema` | string |  | 0.13.0 | JSON Schema URL for editor completion. Studio ignores it. |
| `catalogueVersion` | `1` | yes | 0.13.0 | The catalogue format. Raised only for a change an older Studio cannot ignore. |
| `name` | string | yes | 0.13.0 | The catalogue’s display name. |
| `owner` | string | yes | 0.13.0 | The account that publishes the catalogue. |
| `extensions` | object[] (at most 2048) | yes | 0.13.0 | Listed extensions, at most 2048. Each `id` appears once; Studio keeps the first. An entry this Studio cannot read is skipped, never fatal. |
| `extensions[].id` | string | yes | 0.13.0 | `<publisher>.<id>`: the publisher is the repository owner, lowercased (on a host other than github.com, marked and with the host: `from-gitlab-com-alice`, a form no GitHub owner may take), and the id is the manifest’s `id`. Studio installs under this key. |
| `extensions[].source` | object | yes | 0.13.0 | Where the extension’s source lives. |
| `extensions[].source.url` | string | yes | 0.13.0 | HTTPS or SSH URL of the extension’s git repository. |
| `extensions[].source.ref` | string | yes | 0.13.0 | The branch or tag the author publishes from. Each release pins an exact commit. |
| `extensions[].source.path` | string |  | 0.13.0 | The folder inside the repository that holds `extension.json`, so one repository can publish many extensions. Omit it at the root. |
| `extensions[].ownerId` | integer |  | 0.13.0 | The repository owner’s numeric id, recorded when the extension was first listed. A name can be renamed or taken again; the id cannot. An install records it, and a change pauses updates. |
| `extensions[].description` | string |  | 0.13.0 | Listing text. |
| `extensions[].categories` | string[] (at most 16) |  | 0.13.0 | Lowercase slugs to filter the catalogue by, each listed once, at most 16. |
| `extensions[].releases` | object[] (at most 32) | yes | 0.13.0 | Installable releases, newest first, at most 32. Studio installs the first whose `minimumStudio` it meets, so keep older releases listed when one raises `engines.studio`. |
| `extensions[].releases[].version` | string | yes | 0.13.0 | The manifest’s `version` for this release. |
| `extensions[].releases[].commit` | string | yes | 0.13.0 | The full commit Studio checks out for this release. A listed version keeps its commit: a tag moved later never replaces it. |
| `extensions[].releases[].contentHash` | string | yes | 0.13.0 | The content identity of the extension’s installed files, as Studio computes it at install (`sprintengine-extension release-entry` prints it). Studio refuses bytes that differ. |
| `extensions[].releases[].tier` | `content` \| `declarative` \| `ui` \| `worker` | yes | 0.13.0 | The manifest’s `tier`. |
| `extensions[].releases[].minimumStudio` | string | yes | 0.13.0 | The manifest’s `engines.studio` without `>=`. An older Studio lists the extension but does not install this release. |
| `extensions[].releases[].permissions` | `workspace:read` \| `workspace:operate` \| `conversation:read` \| `backlog:read` \| `backlog:operate` \| `providers:read` \| `usage:read` \| `workspace-files:read` \| `workspace-files:write` \| `storage:own` \| `settings:own` \| `secrets:own` \| `notifications:show` \| `conversation:own` \| `conversation:bypass` \| `chat:draft` \| `schedules:own` \| `agents:generate` \| `agents:companion` \| `github:api` \| `tools:contribute` \| `terminals:send` \| `terminals:read`[] (at most 23) | yes | 0.13.0 | Every permission the release asks for. Studio refuses an install whose manifest asks for different ones. |
| `extensions[].releases[].contributes` | object[] (at most 256) | yes | 0.13.0 | What the release adds, one item per contribution. Studio refuses an install whose manifest adds something else. |
| `extensions[].releases[].contributes[].kind` | `commands` \| `menus` \| `topBarItems` \| `panels` \| `doors` \| `settingsSections` \| `mcpTools` \| `hooks` \| `syntaxes` \| `customEditors` \| `keybindings` \| `statusBarItems` \| `settings` \| `skills` \| `mcpServers` \| `providers` | yes | 0.13.0 | The contribution point. |
| `extensions[].releases[].contributes[].name` | string | yes | 0.13.0 | What the item is called: its id, or its command for a menu or keybinding. |
| `extensions[].releases[].name` | string |  | 0.13.0 | The manifest’s `name`. |
| `extensions[].releases[].license` | string |  | 0.13.0 | SPDX license expression. |
| `extensions[].releases[].repository` | string |  | 0.13.0 | Source repository page. |
| `extensions[].releases[].homepage` | string |  | 0.13.0 | Project homepage. |
| `extensions[].releases[].updatedAt` | string |  | 0.13.0 | When this release was published. |
| `extensions[].releases[].changelog` | string |  | 0.13.0 | What changed in this release, as plain text. |
| `extensions[].releases[].images` | object |  | 0.13.0 | Images stored in the catalogue repository, shown before anything is installed. |
| `extensions[].releases[].images.icon` | object |  | 0.13.0 | Square icon. |
| `extensions[].releases[].images.icon.path` | string | yes | 0.13.0 | The file in the catalogue repository, relative to the folder the catalogue file is in. Studio refuses bytes that differ from `sha256`. |
| `extensions[].releases[].images.icon.sha256` | string | yes | 0.13.0 | SHA-256 of the image’s bytes. |
| `extensions[].releases[].images.icon.alt` | string | yes | 0.13.0 | What the image shows, for screen readers. |
| `extensions[].releases[].images.cover` | object |  | 0.13.0 | Wide cover shown at the top of the extension’s page. |
| `extensions[].releases[].images.cover.path` | string | yes | 0.13.0 | The file in the catalogue repository, relative to the folder the catalogue file is in. Studio refuses bytes that differ from `sha256`. |
| `extensions[].releases[].images.cover.sha256` | string | yes | 0.13.0 | SHA-256 of the image’s bytes. |
| `extensions[].releases[].images.cover.alt` | string | yes | 0.13.0 | What the image shows, for screen readers. |
| `extensions[].releases[].images.screenshots` | object[] (at most 6) |  | 0.13.0 | Screenshots, at most 6. |
| `extensions[].releases[].images.screenshots[].path` | string | yes | 0.13.0 | The file in the catalogue repository, relative to the folder the catalogue file is in. Studio refuses bytes that differ from `sha256`. |
| `extensions[].releases[].images.screenshots[].sha256` | string | yes | 0.13.0 | SHA-256 of the image’s bytes. |
| `extensions[].releases[].images.screenshots[].alt` | string | yes | 0.13.0 | What the image shows, for screen readers. |

### kill-list.json

| Field | Type | Required | Since | Description |
|---|---|---|---|---|
| `killListVersion` | `1` | yes | 0.13.0 | The kill list format. |
| `generatedAt` | string | yes | 0.13.0 | When the list was written. Studio never replaces a list with an older one. |
| `extensions` | object[] (at most 4096) | yes | 0.13.0 | The killed extensions and versions. An id listed twice kills what every entry for it kills. |
| `extensions[].id` | string | yes | 0.13.0 | The killed extension’s install key. |
| `extensions[].versions` | string[] (at most 256) |  | 0.13.0 | The versions killed. Absent, every version is. |
| `extensions[].reason` | string | yes | 0.13.0 | Why, as Studio tells the person. |
| `extensions[].advisoryUrl` | string |  | 0.13.0 | An advisory to read more. |

### owners.json

| Field | Type | Required | Since | Description |
|---|---|---|---|---|
| `ownersVersion` | `1` | yes | 0.13.0 | The owner records format. |
| `owners` | object[] (at most 65536) | yes | 0.13.0 | Every listed owner: its account name and numeric id. |
| `owners[].login` | string | yes | 0.13.0 | The owner’s account name now. |
| `owners[].id` | integer | yes | 0.13.0 | The owner’s numeric id, which a rename keeps. |

### release-lock.json

| Field | Type | Required | Since | Description |
|---|---|---|---|---|
| `lockVersion` | `1` | yes | 0.13.0 | The release lock format. |
| `releases` | object[] (at most 65536) | yes | 0.13.0 | Every version ever listed, with the commit and content hash it was first listed at. A listed version never moves. |
| `releases[].id` | string | yes | 0.13.0 | The install key. |
| `releases[].version` | string | yes | 0.13.0 | The version. |
| `releases[].commit` | string | yes | 0.13.0 | The full commit Studio checks out for this release. A listed version keeps its commit: a tag moved later never replaces it. |
| `releases[].contentHash` | string | yes | 0.13.0 | The content identity of the extension’s installed files, as Studio computes it at install (`sprintengine-extension release-entry` prints it). Studio refuses bytes that differ. |

<!-- generated:extension-catalogue-reference:end -->
