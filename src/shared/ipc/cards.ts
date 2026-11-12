// Running a card and what it hands back: the Studio protocol's shapes
// (`cards.run`, packages/studio-protocol/src/agent-skills.ts), under the names
// the app has always used. ../electron-api.ts re-exports everything here.

export type {
  CardActionOutcome,
  CardActionStatus,
  CardChatHandoff,
  CardRunInput,
  CardRunResult,
  CardSurfaceHandoff,
} from '../../../packages/studio-protocol/src/public'
