# Signing and publishing

## What a signature does and does not do

An extension is signed by a file beside its manifest, `extension/extension.sig`.
It holds the sha256 of every file in the folder (extension.json included,
extension.sig left out), the signer's public key, and an ed25519 signature
over those digests. So a signature says "this key vouches for exactly these
files": the declaration and the code together.

A signature is a badge, not a pass: whatever signs it, an extension beyond
content runs only once the person approves it in Settings → Extensions, and
the approval of an installed extension holds for those exact contents and
that access. A development folder's `extension.sig` is not read at all: a
working copy is not what anybody signed, so sign the folder you pack.

- Unsigned: installable, and shown as unsigned.
- Signed by a publisher key Studio trusts: shown as verified.
- Signed by a key Studio does not know: shown with the key's fingerprint.
- Any change to the folder after signing makes the signature invalid, and an
  invalid extension is refused outright, whatever was approved. Sign again.

## The key

```sh
npm run keygen    # sprintengine-extension keygen --out ~/.sprintengine/keys/<id>.key
```

- The private key is a PKCS#8 PEM file, mode 600. It never goes in the
  project, never in git, never in CI logs. `pack` never copies `*.key` /
  `*.pem` files, the validators refuse them, and `.gitignore` ignores them.
- Back it up. Losing it means publishing under a new fingerprint, and your
  extension no longer shows as signed by the old one.
- In CI, keep it in a secret and write it to a temp file for the `sign` step.

## Sign, verify, pack

```sh
npm run check
npx sprintengine-extension sign extension --key ~/.sprintengine/keys/<id>.key   # writes extension/extension.sig
npx sprintengine-extension verify extension                                     # the signature AND every file, as Studio checks them
npx sprintengine-extension pack extension --out packed/<id>                     # an installable copy without keys or node_modules
```

`sign` validates extension.json, checks that every file it names is there, and
signs the digests of every file `pack` would copy. `verify` exits 1 when the
extension is unsigned or anything changed after signing. Sign again after any
change.

There is nothing to build first: what you pack is the source you tried with
`npm run dev`. `pack` copies `extension/` as it is, leaving out
`node_modules`, `.git`, key files and symbolic links. Every other file in
`extension/` ships, so keep only what the extension needs there.

## Release checklist

1. Raise `version` in `extension/extension.json`.
2. `npm run check`.
3. Sign `extension/` (above), after its last change.
4. `npx sprintengine-extension verify extension`.
5. Hand over the folder: `npm run pack` (`packed/<id>/`), or the repository
   with `extension/` committed, extension.sig included.

## Installing

People install an extension from a folder: Settings → Extensions, install from
a folder, pointing at a packed copy. Studio copies it under
`~/.sprintengine/extensions/local.<id>/`; the `local` publisher is what a
folder install is. It waits for the person's approval, which shows what it
asks for and its signer, and loads as soon as it is approved, with no restart
of Studio. A new version installed the same way keeps the approval when it
asks for no more access, and loads at once.

Installing is for using an extension. While you work on one, load it as a
development folder instead (`npm run dev`, or Settings → Extensions →
Install → As a development folder): it loads from where it is and again on
every save. A development folder whose id an installed extension has stands
in for it once the person approves that, under its own approval; remove the folder
and the installed one asks for its own approval again.

People also install from a catalogue (Settings → Extensions → Browse) or a
git URL; Studio checks out the commit and installs the extension's folder
under the repository owner's name. Listing an extension in a catalogue is the
`catalogue` topic: `npx sprintengine-extension release-entry` prints the entry.

## The SDK itself

Projects depend on `@sprintengine/extension-sdk` from npm. To try an
unreleased SDK, depend on a local tarball
(`"@sprintengine/extension-sdk": "file:vendor/sprintengine-extension-sdk-<v>.tgz"`)
— the scaffolder's `--sdk-tarball` option sets that up, and a project Studio
scaffolds depends on the copy that ships with Studio.

## Skills, MCP servers and providers

An extension hands agents a skill, an MCP server or a model provider with
`contributes.skills`, `contributes.mcpServers` and `contributes.providers` in
its extension.json (the `manifest` topic), and publishes them the way it
publishes everything else. There is no separate bundle for them.
