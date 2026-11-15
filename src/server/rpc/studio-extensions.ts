import type {
  StudioErrorBody,
  StudioExtensionsMethodMap,
  StudioGrant,
  StudioHandlerOf,
} from '../../../packages/studio-protocol/src/public'
import { isMachinePath } from '../../shared/machine-paths'
import type { StudioExtensions } from '../extensions/extensions-domain'
import type { StudioRequestContext } from './studio-rpc-types'

// The router's answers to the extensions family (`marketplace.*`,
// `cliPlugins.*`, `studioPlugin.status`, `extensionScaffold.*`, `cardFeed.get`,
// `sourcesFeed.get`): each method's domain call, once the router has held the
// grant to the method's scope and an owner's methods to an owner. What is left
// here is the family's own rules: an install, an update, an uninstall and a
// new project are carried out once per command id, a retry answered with the
// first answer; and Studio's plugin is read in a folder a client that is not
// an owner may name only inside the folders Studio knows.

export type StudioExtensionsAsking = {
  grant: StudioGrant
  context: StudioRequestContext
  voice: { failed(code: 'unavailable', detail: string | undefined, context: string): unknown }
}

type Method = keyof StudioExtensionsMethodMap
export type StudioExtensionsHandlers = {
  readonly [M in Method]: StudioHandlerOf<StudioExtensionsMethodMap[M], StudioExtensionsAsking>
}

type Refused<C extends string> = { ok: false; error: StudioErrorBody & { code: C } }
type Kept = <A extends { ok: boolean; error?: StudioErrorBody }>(
  id: string,
  work: () => Promise<A>,
  voice: StudioExtensionsAsking['voice'],
  method: string,
) => Promise<A | Refused<'unavailable'>>

export type StudioExtensionsHandlerOptions = {
  /** The domain; without it, every method is answered `unavailable`. */
  extensions?: StudioExtensions
  /** The first answer to a command id is every retry's. */
  once: Kept
  /** A client's command id, namespaced by the client. */
  runtimeId(grant: StudioGrant, commandId: string): string
  /** Whether the asker may name this folder: any, for an owner's own connection; else one Studio knows. */
  mayName(path: string, asking: { grant: StudioGrant; context: StudioRequestContext }): Promise<boolean>
}

const ON_ANOTHER_MACHINE =
  'An extension is made on the machine its Studio runs on; a folder on an SSH machine is not one of its folders.'

function onAnotherMachine(input: { folder?: string; parentDir?: string }): boolean {
  return [input.folder, input.parentDir].some((path) => path !== undefined && isMachinePath(path))
}

const unserved = (method: Method): Refused<'unavailable'> => ({
  ok: false,
  error: { code: 'unavailable', message: `This Studio does not serve ${method}.` },
})

function ok<T>(result: T): { ok: true; result: T } {
  return { ok: true, result }
}

export function createStudioExtensionsHandlers(options: StudioExtensionsHandlerOptions): StudioExtensionsHandlers {
  const { extensions } = options

  /** A command carried out once under the client's id; its params without the id go to the domain. */
  function command<M extends Method, R>(
    method: M,
    commandId: string,
    asking: StudioExtensionsAsking,
    work: (extensions: StudioExtensions) => Promise<R>,
  ): Promise<{ ok: true; result: R } | Refused<'unavailable'>> | Refused<'unavailable'> {
    if (!extensions) return unserved(method)
    return options.once(
      `${method}:${options.runtimeId(asking.grant, commandId)}`,
      async () => ok(await work(extensions)),
      asking.voice,
      method,
    )
  }

  return {
    'marketplace.read': async (input) =>
      extensions ? ok(await extensions.marketplace.read(input)) : unserved('marketplace.read'),
    'marketplace.updateStates': async (input) =>
      extensions ? ok(await extensions.marketplace.updateStates(input)) : unserved('marketplace.updateStates'),
    'marketplace.verify': async ({ id }) =>
      extensions ? ok(await extensions.marketplace.verify(id)) : unserved('marketplace.verify'),
    'marketplace.install': ({ commandId, ...input }, asking) =>
      command('marketplace.install', commandId, asking, (domain) => domain.marketplace.install(input)),
    'marketplace.update': ({ commandId, ...input }, asking) =>
      command('marketplace.update', commandId, asking, (domain) => domain.marketplace.update(input)),
    'marketplace.uninstall': ({ commandId, ...input }, asking) =>
      command('marketplace.uninstall', commandId, asking, (domain) => domain.marketplace.uninstall(input)),
    'marketplace.resolveGithub': async ({ url }) =>
      extensions ? ok(await extensions.marketplace.resolveGithub(url)) : unserved('marketplace.resolveGithub'),
    'marketplace.installGithub': ({ commandId, ...input }, asking) =>
      command('marketplace.installGithub', commandId, asking, (domain) => domain.marketplace.installGithub(input)),

    'cliPlugins.list': () => (extensions ? ok(extensions.cliPlugins()) : unserved('cliPlugins.list')),
    'cliPlugins.availability': async (input) =>
      extensions ? ok(await extensions.cliAvailability(input)) : unserved('cliPlugins.availability'),
    'cliPlugins.launchPreview': (input) =>
      extensions ? ok(extensions.launchPreview(input)) : unserved('cliPlugins.launchPreview'),

    'studioPlugin.status': async ({ workspaceFolder }, asking) => {
      if (!extensions) return unserved('studioPlugin.status')
      if (workspaceFolder !== null && !(await options.mayName(workspaceFolder, asking)))
        return { ok: false, error: { code: 'not_found', message: 'That folder is not one Studio knows.' } }
      const status = extensions.studioPluginStatus(workspaceFolder)
      return status ? ok(await status) : unserved('studioPlugin.status')
    },

    'extensionScaffold.home': () =>
      extensions ? ok({ folder: extensions.scaffold.home() }) : unserved('extensionScaffold.home'),
    // A project is made on this Studio's own disk: a folder on an SSH machine
    // is not one of its folders, and is answered so rather than read here.
    'extensionScaffold.target': (input) => {
      if (!extensions) return unserved('extensionScaffold.target')
      return ok({ target: onAnotherMachine(input) ? null : extensions.scaffold.target(input) })
    },
    'extensionScaffold.create': ({ commandId, ...input }, asking) =>
      onAnotherMachine(input)
        ? ok({ ok: false, code: 'no_parent', message: ON_ANOTHER_MACHINE })
        : command('extensionScaffold.create', commandId, asking, (domain) => domain.scaffold.create(input)),

    'cardFeed.get': async () => (extensions ? ok(await extensions.cardFeed()) : unserved('cardFeed.get')),
    'sourcesFeed.get': async () => (extensions ? ok(await extensions.sourcesFeed()) : unserved('sourcesFeed.get')),
  }
}
