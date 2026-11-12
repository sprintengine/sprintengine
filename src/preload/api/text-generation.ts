import { ipc as ipcRenderer } from '../ipc-router'
import type { ElectronApi } from '../../shared/electron-api'
import type {
  PullRequestTextResult,
  TextGenerationCliRuntimeOverrides,
  TextGenerationEngine,
} from '../../shared/text-generation/contract'
import type { TextGenerationWritingStyle } from '../../shared/text-generation/writing-style'
import type {
  CreatePullRequestOutcome,
  CreatePullRequestState,
  PullRequestCheckoutPin,
  PushForPullRequestOutcome,
} from '../../shared/git/pull-request-create'

export const textGenerationApi = {
  createPullRequestState: (cwd: string): Promise<CreatePullRequestState | null> =>
    ipcRenderer.invoke('pull-request-create:state', cwd),
  draftPullRequestText: (request: {
    cwd: string
    engine: TextGenerationEngine
    cliRuntimes?: TextGenerationCliRuntimeOverrides
    draftId?: string
    writingStyle?: TextGenerationWritingStyle
  }): Promise<PullRequestTextResult> => ipcRenderer.invoke('pull-request-create:draft', request),
  cancelPullRequestDraft: (draftId: string): Promise<void> =>
    ipcRenderer.invoke('pull-request-create:draft-cancel', draftId),
  pushForPullRequest: (cwd: string, pin?: PullRequestCheckoutPin): Promise<PushForPullRequestOutcome> =>
    ipcRenderer.invoke('pull-request-create:push', cwd, pin),
  createPullRequest: (input: {
    cwd: string
    title: string
    body: string
    pin?: PullRequestCheckoutPin
  }): Promise<CreatePullRequestOutcome> => ipcRenderer.invoke('pull-request-create:create', input),
} satisfies Pick<
  ElectronApi,
  | 'createPullRequestState'
  | 'draftPullRequestText'
  | 'cancelPullRequestDraft'
  | 'pushForPullRequest'
  | 'createPullRequest'
>
