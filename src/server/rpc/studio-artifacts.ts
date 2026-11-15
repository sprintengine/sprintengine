import type {
  StudioArtifactsMethodMap,
  StudioErrorBody,
  StudioGrant,
  StudioHandlerOf,
} from '../../../packages/studio-protocol/src/public'
import type { StudioArtifacts } from '../artifacts/artifacts-domain'

// The router's answers to the artifacts family (`artifacts.*`): each method's
// domain call, once the router has held the grant to the method's scope and
// to an owner's connection, which every one of them is. What is left here is
// the family's own rule: a set-up and an answer are carried out once per
// command id, a retry answered with the first answer.

export type StudioArtifactsAsking = {
  grant: StudioGrant
  voice: { failed(code: 'unavailable', detail: string | undefined, context: string): unknown }
}

type Method = keyof StudioArtifactsMethodMap
export type StudioArtifactsHandlers = {
  readonly [M in Method]: StudioHandlerOf<StudioArtifactsMethodMap[M], StudioArtifactsAsking>
}

type Refused = { ok: false; error: StudioErrorBody & { code: 'unavailable' } }

export type StudioArtifactsHandlerOptions = {
  /** The domain; without it, every method is answered `unavailable`. */
  artifacts?: StudioArtifacts
  /** The first answer to a command id is every retry's. */
  once: <A extends { ok: boolean; error?: StudioErrorBody }>(
    id: string,
    work: () => Promise<A>,
    voice: StudioArtifactsAsking['voice'],
    method: string,
  ) => Promise<A | Refused>
  /** A client's command id, namespaced by the client. */
  runtimeId(grant: StudioGrant, commandId: string): string
}

const unserved = (method: Method): Refused => ({
  ok: false,
  error: { code: 'unavailable', message: `This Studio does not serve ${method}.` },
})

function ok<T>(result: T): { ok: true; result: T } {
  return { ok: true, result }
}

export function createStudioArtifactsHandlers(options: StudioArtifactsHandlerOptions): StudioArtifactsHandlers {
  const { artifacts } = options

  function command<R>(
    method: Method,
    commandId: string,
    asking: StudioArtifactsAsking,
    work: (artifacts: StudioArtifacts) => Promise<R>,
  ): Promise<{ ok: true; result: R } | Refused> | Refused {
    if (!artifacts) return unserved(method)
    return options.once(
      `${method}:${options.runtimeId(asking.grant, commandId)}`,
      async () => ok(await work(artifacts)),
      asking.voice,
      method,
    )
  }

  return {
    'artifacts.settings': async () => (artifacts ? ok(await artifacts.settings()) : unserved('artifacts.settings')),
    'artifacts.setUp': ({ commandId, input, save }, asking) =>
      command('artifacts.setUp', commandId, asking, (domain) => domain.setUp(input, save)),
    'artifacts.answerSetupQuestion': ({ commandId, id, confirmed }, asking) =>
      command('artifacts.answerSetupQuestion', commandId, asking, async (domain) => ({
        answered: domain.answerSetupQuestion(id, confirmed),
      })),
  }
}
