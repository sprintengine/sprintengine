// The ideas the New chat door offers in extension mode, one for each surface
// an extension can add (the SDK's templates, packages/extension-sdk/templates), so
// the cards together show what the SDK reaches.
//
// A card starts nothing. Choosing one puts its `prompt` in the box as it is,
// for the person to change before they send it: the words are theirs from
// then on, so each one reads as a person would put it, first person, with the
// surface named.

import { copy } from '../../../../../shared/copy'

export type ExtensionIdea = {
  id: string
  /** What the idea adds to Studio, in the words the SDK's surface table uses. */
  surface: string
  title: string
  /** One line under the title. */
  description: string
  /** What goes in the box. */
  prompt: string
}

export const EXTENSION_IDEAS: readonly ExtensionIdea[] = [
  {
    id: 'top-bar-item',
    surface: 'Top bar',
    title: copy.workspace.agentComposer.extensionIdeas.pRReviewBadge,
    description: copy.workspace.agentComposer.extensionIdeas.aCountOfThePRs,
    prompt:
      'A top-bar badge counting the pull requests waiting on my review; clicking it lists them and opens one in the browser.',
  },
  {
    id: 'mcp-tools',
    surface: 'MCP tools',
    title: copy.workspace.agentComposer.extensionIdeas.toolsForMyIssueTracker,
    description: copy.workspace.agentComposer.extensionIdeas.letAnyAgentSearchAnd,
    prompt: "MCP tools any agent can call to search my team's issue tracker and add a comment to an issue.",
  },
  {
    id: 'door',
    surface: 'Page in Extensions',
    title: copy.workspace.agentComposer.extensionIdeas.releaseDashboard,
    description: copy.workspace.agentComposer.extensionIdeas.openPRsAndCIStatus,
    prompt:
      'A full page, opened from the Extensions drawer, that shows open pull requests and CI status for every project I have open.',
  },
  {
    id: 'backlog-action',
    surface: 'Backlog action',
    title: copy.workspace.agentComposer.extensionIdeas.breakItDown,
    description: copy.workspace.agentComposer.extensionIdeas.splitABacklogItemInto,
    prompt:
      'A Backlog item action that starts a chat to split the item into smaller items, each one a day of work or less.',
  },
  {
    id: 'panel',
    surface: 'Panel',
    title: copy.workspace.agentComposer.extensionIdeas.projectScratchpad,
    description: copy.workspace.agentComposer.extensionIdeas.perProjectNotesThatPersist,
    prompt:
      'A scratchpad panel for each project that keeps my notes between sessions and lets me paste a note into a chat.',
  },
  {
    id: 'hook-guard',
    surface: 'Agent hooks',
    title: copy.workspace.agentComposer.extensionIdeas.guardForAgentCommands,
    description: copy.workspace.agentComposer.extensionIdeas.refuseRiskyCommandsBefore,
    prompt:
      'A guard that refuses any agent’s shell command that force-pushes or deletes outside the project, and tells the agent why.',
  },
  {
    id: 'editor',
    surface: 'Editor',
    title: copy.workspace.agentComposer.extensionIdeas.envFileForm,
    description: copy.workspace.agentComposer.extensionIdeas.editEnvFilesAsAForm,
    prompt:
      'An editor that opens .env files as a form of names and values, marks the ones left empty, and keeps the comments as they are.',
  },
  {
    id: 'file-action',
    surface: 'Files action',
    title: copy.workspace.agentComposer.extensionIdeas.explainThisFile,
    description: copy.workspace.agentComposer.extensionIdeas.aChatThatWalksThrough,
    prompt:
      'A Files action that opens a chat explaining the selected file: what it does, who calls it and what to watch out for.',
  },
  {
    id: 'chat-companion',
    surface: 'Chats',
    title: copy.workspace.agentComposer.extensionIdeas.secondOpinionReviewer,
    description: copy.workspace.agentComposer.extensionIdeas.reviewsWhatAnotherChatChanged,
    prompt: 'When a chat finishes, start a second chat that reviews the changes it made and reports anything risky.',
  },
  {
    id: 'settings-section',
    surface: 'Settings',
    title: copy.workspace.agentComposer.extensionIdeas.commitConventions,
    description: copy.workspace.agentComposer.extensionIdeas.aSettingsSectionForYour,
    prompt:
      'A Settings section where I set our commit-message rules, and a command that checks the staged message against them.',
  },
  {
    id: 'blank',
    surface: 'Command',
    title: copy.workspace.agentComposer.extensionIdeas.copyBranchLink,
    description: copy.workspace.agentComposer.extensionIdeas.aPaletteCommandThatCopies,
    prompt: 'A command in the palette that copies a link to the current branch on GitHub.',
  },
]

/** How many show before "Show all": four, each a different surface. */
export const EXTENSION_IDEAS_FIRST = 4
