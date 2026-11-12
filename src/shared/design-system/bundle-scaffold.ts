// Result shape for design-system bundle scaffolding (the Studio protocol's
// `designSystem.seed`). Scaffolding stamps the bundle layout from
// resources/design-system/templates into a workspace so a bundle author's
// design-system preset starts from a well-formed, lintable bundle — see
// resources/design-system/templates/USAGE.md for the layout contract.

export type { DesignSystemScaffoldResult } from '../../../packages/studio-protocol/src/public'
/**
 * Where the bundle lives inside a workspace, for both the main-process writer
 * (scaffold, runner discovery) and the renderer watcher/indexer (studio).
 * Single definition on the shared boundary so the two sides cannot drift;
 * attach uses the same directory name.
 */
export const DESIGN_SYSTEM_BUNDLE_DIRECTORY_NAME = 'design-system'
