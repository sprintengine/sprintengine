import { app, shell } from 'electron'

import type { StudioFileSystemShell } from '../server/files/studio-file-system'
import { createProjectLogoIo } from './project-logo-io'

// What a desktop's shell adds to the files the Studio core serves on its
// disk (`server/files/studio-file-system.ts`): what only Electron can do.
// - Moving a file to the Trash (`shell.trashItem`).
// - Shrinking a project's logo with Electron's image codec.
// - Naming this person's Documents folder as the operating system does.

export function desktopFileSystemShell(): StudioFileSystemShell {
  return {
    trash: (path) => shell.trashItem(path),
    projectLogoIo: createProjectLogoIo(),
    defaultWorkspaceParent: () => {
      try {
        return app.getPath('documents')
      } catch {
        try {
          return app.getPath('home')
        } catch {
          return null
        }
      }
    },
  }
}
