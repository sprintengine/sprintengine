import type {
  FolderBrowserListing,
  PreviewOpenAnswer,
  PreviewPort,
  PreviewSummary,
  StudioErrorBody,
  StudioGrant,
  StudioHandlerOf,
  StudioWebTabMethodMap,
  WebTabLoopbackName,
} from '../../../packages/studio-protocol/src/public'

// The router's answers to a web tab's own asks (`webFolders.browse`,
// `webPreviews.*`), once the router has held the grant to an owner's
// connection, which every one of them is. The front door holds the folder
// browser and the previews, and hands its domain over once it starts
// (`provideWebTab`); until it does, and on a Studio that runs none, every
// method is answered `unavailable` and the capability is not offered. A
// command is carried out once per command id.
//
// Each ask is the asking browser's: its session is named by its grant
// (`web:<session id>`), and only a browser paired on this machine's loopback
// is shown a folder or a port.

/** The folder browser and the previews, as the front door holds them, each asked as one browser. */
export type StudioWebTabDomain = {
  browse(clientId: string, input: { path?: string; showHidden?: boolean }): Promise<FolderBrowserListing>
  ports(clientId: string): Promise<{ ports: PreviewPort[] }>
  open(clientId: string, input: { port: number; typed?: boolean; host: WebTabLoopbackName }): Promise<PreviewOpenAnswer>
  close(clientId: string, previewId: string): Promise<boolean>
  /** The previews the browser `clientId` has open now. */
  previews(clientId: string): PreviewSummary[]
  /** Every change of a browser's previews: the listener reads its own again. */
  onPreviewsChanged(listener: () => void): () => void
}

export type StudioWebTabAsking = {
  grant: StudioGrant
  voice: { failed(code: 'unavailable', detail: string | undefined, context: string): unknown }
}

type Method = keyof StudioWebTabMethodMap
export type StudioWebTabHandlers = {
  readonly [M in Method]: StudioHandlerOf<StudioWebTabMethodMap[M], StudioWebTabAsking>
}

type Refused = { ok: false; error: StudioErrorBody & { code: 'unavailable' } }

export type StudioWebTabHandlerOptions = {
  /** The domain, once the front door gave it; null where no web listener runs. */
  webTab: () => StudioWebTabDomain | null
  /** The first answer to a command id is every retry's. */
  once: <A extends { ok: boolean; error?: StudioErrorBody }>(
    id: string,
    work: () => Promise<A>,
    voice: StudioWebTabAsking['voice'],
    method: string,
  ) => Promise<A | Refused>
  /** A client's command id, namespaced by the client. */
  runtimeId(grant: StudioGrant, commandId: string): string
}

const unserved = (method: Method): Refused => ({
  ok: false,
  error: { code: 'unavailable', message: `This Studio runs no web listener, so it does not serve ${method}.` },
})

function ok<T>(result: T): { ok: true; result: T } {
  return { ok: true, result }
}

export function createStudioWebTabHandlers(options: StudioWebTabHandlerOptions): StudioWebTabHandlers {
  function command<R>(
    method: Method,
    commandId: string,
    asking: StudioWebTabAsking,
    work: (domain: StudioWebTabDomain) => Promise<R>,
  ): Promise<{ ok: true; result: R } | Refused> | Refused {
    const domain = options.webTab()
    if (!domain) return unserved(method)
    return options.once(
      `${method}:${options.runtimeId(asking.grant, commandId)}`,
      async () => ok(await work(domain)),
      asking.voice,
      method,
    )
  }

  return {
    'webFolders.browse': async (params, { grant }) => {
      const domain = options.webTab()
      return domain ? ok(await domain.browse(grant.clientId, params)) : unserved('webFolders.browse')
    },
    'webPreviews.list': async (_params, { grant }) => {
      const domain = options.webTab()
      return domain ? ok(await domain.ports(grant.clientId)) : unserved('webPreviews.list')
    },
    'webPreviews.open': ({ commandId, ...input }, asking) =>
      command('webPreviews.open', commandId, asking, (domain) => domain.open(asking.grant.clientId, input)),
    'webPreviews.close': ({ commandId, previewId }, asking) =>
      command('webPreviews.close', commandId, asking, async (domain) => ({
        closed: await domain.close(asking.grant.clientId, previewId),
      })),
  }
}
