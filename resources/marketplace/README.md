# First-Party Marketplace Seed Registry

This directory is the source registry content for the curated first-party
marketplace seed set. When published to `sprintengine/studio-releases`, this
directory is the repository root.

- Local registry path: `resources/marketplace/marketplace.json`
- First-party icon assets: `resources/marketplace/icons/`
- Publisher public keys: `resources/marketplace/trusted-publishers.json`
- Publish CI root workflow:
  `resources/marketplace/.github/workflows/marketplace-registry.yml`
- Remote publication target for the `RegistryClient` default:
  `https://raw.githubusercontent.com/sprintengine/studio-releases/main/marketplace.json`

Publishing keeps `marketplace.json`, `icons/`, `skills/`,
`trusted-publishers.json`, and `.github/workflows/marketplace-registry.yml` at
the same relative paths.

## What the index holds

Two kinds of row, and nothing else:

- **Agent CLIs the app ships** (`cli: { pluginId }`, `provides: ['cli']`). The
  plugin lives inside the app; installing it runs that plugin's `install` spec
  through the CLI runtime installer. These are the 18 rows of this seed.
- **Claude Code plugins** (tagged `claude-plugin`, `provides: ['skills']`, a
  `source` on an allowlisted HTTPS host). Their skills install from content
  bundled with the app under `skills/<id>/`, each folder checked byte for byte
  against the digests the row records, and only on the person's approval.

Skills, MCP servers and model providers of an extension are not registry rows.
An extension declares them as `contributes.skills`, `contributes.mcpServers`
and `contributes.providers` in its own extension.json. The signed plugin
bundle (`plugin.json` with `components.mcp` / `components.skills`) and the
inline MCP row (`mcp.servers`) that once carried them are gone (2026-11-22),
with the `plugins/` payload directory. A published index that still lists a
bundle row, an inline MCP row or an `automation` row has that row left off the
shelf; the rest of the index still reads.

`trusted-publishers.json` stays: an agent-CLI row may set
`publisher.verified: true` only under a name listed there as verified, its
identity proven by the signed app bundle the plugin ships inside. No other row
may claim a verified publisher.

Every entry in `marketplace.json` is hand-authored. This directory is the
source of truth; it is published to `studio-releases`, not read back from it.

## Source policy

- **Allowlisted sources, not a single-repo pin**: a row's `source` must be
  HTTPS on an allowlisted host (`github.com`, `api.github.com`,
  `raw.githubusercontent.com`, plus an optional
  `SPRINTENGINE_MARKETPLACE_EXTRA_HOSTS` list).
- **Registry read is config-swappable**: `SPRINTENGINE_MARKETPLACE_REGISTRY_URL`
  can point the read at a hosted catalogue's `GET /v1/registry`; this seed
  stays the offline/packaged fallback either way.

## Verification

Run this from the studio repo root to validate the local seed registry:

```bash
npm run verify:marketplace-registry
```

When validating a standalone registry checkout, pass that checkout as the root:

```bash
npm run verify:marketplace-registry -- --root ../marketplace
```

The verifier reads `marketplace.json` through the app's own schema validator
and checks unique ids, allowlisted HTTPS sources, icons (an inline icon must be
the bytes of the committed `icons/<id>.svg`), that each agent-CLI row names a
plugin the app bundles and claims a verified publisher only under a trusted
name, that bundled Claude plugin skill payloads match their recorded digests
(and that no payload folder is unclaimed), and that no key material is
committed.

The published registry workflow checks out the studio's validation tooling
and runs:

```bash
npm run verify:marketplace-registry -- --root "$GITHUB_WORKSPACE/registry"
npx vitest run resources/marketplace/verify-marketplace.test.ts
```
