# Signing and publishing

## What a signature does and does not do

An extension is signed by a file beside its manifest, `extension/extension.sig`.
It holds the sha256 of every file in the folder (extension.json included,
extension.sig left out), the signer's public key, and an ed25519 signature
over those digests. So a signature says "this key vouches for exactly these
files": the declaration and the code together.

- Unsigned: installable. Studio waits for the person to trust it in
  Settings → Extensions, and the trust holds for those exact contents.
- Signed by a publisher key the person trusts: trusted without asking.
- Signed by a key Studio does not know: shown with the key's fingerprint, and
  the person still decides.
- Any change to the folder after signing makes the signature invalid, and an
  invalid extension is refused outright (not merely untrusted). Sign again.

## The key

```sh
npm run keygen    # sprintengine-extension keygen --out ~/.sprintengine/keys/<id>.key
```

- The private key is a PKCS#8 PEM file, mode 600. It never goes in the
  project, never in git, never in CI logs. `pack` never copies `*.key` /
  `*.pem` files, the validators refuse them, and `.gitignore` ignores them.
- Back it up. Losing it means publishing under a new fingerprint, and people
  who trusted the old one are asked again.
- In CI, keep it in a secret and write it to a temp file for the `sign` step.

## Sign, verify, pack

```sh
npm run build
npx sprintengine-extension sign extension --key ~/.sprintengine/keys/<id>.key   # writes extension/extension.sig
npx sprintengine-extension verify extension                                     # the signature AND every file, as Studio checks them
npx sprintengine-extension pack extension --out packed/<id>                     # an installable copy without keys or node_modules
```

`sign` validates extension.json, checks that every file it names is there, and
signs the digests of every file `pack` would copy. `verify` exits 1 when the
extension is unsigned or anything changed after signing. Sign again after any
change.

`npm run dev:install` signs the copy it installs whenever a key is at hand
(`--key`, `$SPRINTENGINE_SIGNING_KEY`, or `~/.sprintengine/keys/<id>.key`), so
what you try is what you would ship. It leaves `extension/` itself alone.

## Release checklist

1. Raise `version` in `extension/extension.json`.
2. `npm run check`.
3. Sign `extension/` (above).
4. `node scripts/validate.mjs` — with extension.sig present it runs `verify`.
5. Hand over the folder: `npx sprintengine-extension pack extension`, or the
   repository with `extension/` committed, build and extension.sig included.

## Installing

People install an extension from a folder: Settings → Extensions, install from
a folder, pointing at `extension/` or a packed copy. Studio copies it under
`~/.sprintengine/extensions/local.<id>/`; the `local` publisher is what a
folder install is. An unsigned folder waits for trust; a signed one shows its
signer.

## The SDK itself

Projects depend on `@sprintengine/extension-sdk` from npm. To try an
unreleased SDK, depend on a local tarball
(`"@sprintengine/extension-sdk": "file:vendor/sprintengine-extension-sdk-<v>.tgz"`)
— the scaffolder's `--sdk-tarball` option sets that up, and a project Studio
scaffolds depends on the copy that ships with Studio.

## Plugin bundles are something else

A marketplace plugin bundle (`plugin.json`) carries MCP server configs and
skills, not an extension. `sprintengine-extension plugin scaffold|sign|verify|pack`
work on those; see the plugin author guide in the app repository. A bundle
that names a `module` component is refused.
