import { join } from 'node:path'

import type { StudioPaths } from '../../server/platform/studio-paths'

// Resolves resources/design-system/templates for the running Studio. Packaged
// builds carry the folder as an extraResource (`design-system/templates`
// under the resources directory; see package.json `build.extraResources`);
// a source checkout reads it from the repository. Kept separate from
// bundle-scaffold.ts so the scaffold service stays testable under plain Node.
export function resolveDesignSystemTemplatesDir(paths: StudioPaths): string {
  const resources = paths.resourcesDir()
  if (paths.isPackaged() && resources) return join(resources, 'design-system', 'templates')
  return join(paths.appRoot() ?? process.cwd(), 'resources', 'design-system', 'templates')
}
