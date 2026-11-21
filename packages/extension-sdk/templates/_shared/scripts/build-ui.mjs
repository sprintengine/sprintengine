#!/usr/bin/env node
// Bundle each surface extension.json names into extension/dist/.
//
//   node scripts/build-ui.mjs [--project <dir>]
//
// A panel's, door's or settings section's `entry` is `dist/<name>.js` (or
// `.mjs`), built from `src/<name>.tsx` (or `.ts`, `.jsx`, `.js`). Studio
// imports the built file on its own, with nothing beside it to resolve an
// import against, so each bundle carries everything it imports, React
// included. Add a surface to extension.json and this builds it; there is no
// list to keep here.

import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'

import { build } from 'esbuild'

import { extensionDirOf, fail, loadSdk, projectDirFrom, readManifest } from './module-tools.mjs'

const projectDir = projectDirFrom(process.argv.slice(2))
const extensionDir = extensionDirOf(projectDir)
const { sdk } = await loadSdk(projectDir)
const manifest = readManifest(sdk, projectDir)

const entries = [
  ...new Set(sdk.EXTENSION_SURFACE_POINTS.flatMap((point) => manifest.contributes[point].map((item) => item.entry))),
]
if (entries.length === 0) {
  console.log('No panels, doors or settings sections to build.')
  process.exit(0)
}

const SOURCE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js']
const builds = entries.map((entry) => {
  const name = /^dist\/(.+)\.m?js$/.exec(entry)?.[1]
  if (!name) fail(`${entry}: build-ui builds entries under dist/, ending in .js or .mjs.`)
  const source = SOURCE_EXTENSIONS.map((extension) => join(projectDir, 'src', `${name}${extension}`)).find(existsSync)
  if (!source) fail(`${entry} is built from src/${name}.tsx, which does not exist.`)
  return { entry, source }
})

await Promise.all(
  builds.map(({ entry, source }) =>
    build({
      entryPoints: [source],
      outfile: join(extensionDir, entry),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'chrome130',
      jsx: 'automatic',
      loader: { '.css': 'text' },
      define: { 'process.env.NODE_ENV': '"production"' },
      minify: true,
      legalComments: 'none',
      logLevel: 'warning',
    }),
  ),
).catch((error) => fail(`The build failed: ${error instanceof Error ? error.message : error}`))

for (const { entry, source } of builds) console.log(`${relative(projectDir, source)} → extension/${entry}`)
