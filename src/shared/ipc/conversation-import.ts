// Bringing the conversations a person had in an agent CLI's own terminal into
// the app as chats: the Studio protocol's `conversationImport.*`, whose types
// the package defines. ../electron-api.ts re-exports everything here.
export type {
  ConversationImportFolder,
  ConversationImportInput,
  ConversationImportResult,
  ConversationImportScanResult,
  ConversationImportSession,
  ConversationImportSource,
} from '../../../packages/studio-protocol/src/public'
