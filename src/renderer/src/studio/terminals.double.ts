import type * as Terminals from './terminals'

// A stand-in for the window's terminals (`terminals.ts`), for tests of what
// calls them. A test mocks the module with this one:
//
//   vi.mock('../../studio/terminals', () => import('../../studio/terminals.double'))
//
// and sets what it needs on `terminalsDouble`: each call goes to the member
// of the same name there, as it stands when the call is made. Unset, a call
// does what a window with no terminals would: lists nothing, starts nothing.

type Module = typeof Terminals
// What a test sets: a member taking the real one's arguments, answering what the test needs.
type Double = { -readonly [K in keyof Module]: (...args: Parameters<Module[K]>) => unknown }

export const terminalsDouble: Double = blank()

function blank(): Double {
  return {
    onTerminalReplay: () => () => undefined,
    onTerminalData: () => () => undefined,
    onTerminalExit: () => () => undefined,
    onTerminalError: () => () => undefined,
    onTerminalSessionsDelta: () => () => undefined,
    onTerminalPromptUndelivered: () => () => undefined,
    openTerminal: async (sessionId) => ({ ok: false, sessionId, message: 'No terminals here.', exitCode: 1 }),
    resumeTerminal: async (sessionId) => ({ ok: false, sessionId, message: 'No terminals here.', exitCode: 1 }),
    setTerminalVisible: async () => undefined,
    resizeTerminal: async () => undefined,
    terminalStatus: async () => ({ processAlive: false, suspended: false }),
    listTerminals: async () => [],
    suspendTerminal: async () => undefined,
    closeTerminal: async () => undefined,
    setTerminalReapExempt: async () => undefined,
    configureTerminals: async () => undefined,
    takeUndeliveredPrompts: async () => [],
    ackTerminal: () => undefined,
    writeTerminal: async () => true,
    terminalWritePieces: (data) => [data],
    resetTerminalsForTests: () => undefined,
  }
}

/** Put every member back as it was. */
export function resetTerminalsDouble(): void {
  Object.assign(terminalsDouble, blank())
}

export const onTerminalReplay: Module['onTerminalReplay'] = (...args) =>
  terminalsDouble.onTerminalReplay(...args) as ReturnType<Module['onTerminalReplay']>
export const onTerminalData: Module['onTerminalData'] = (...args) =>
  terminalsDouble.onTerminalData(...args) as ReturnType<Module['onTerminalData']>
export const onTerminalExit: Module['onTerminalExit'] = (...args) =>
  terminalsDouble.onTerminalExit(...args) as ReturnType<Module['onTerminalExit']>
export const onTerminalError: Module['onTerminalError'] = (...args) =>
  terminalsDouble.onTerminalError(...args) as ReturnType<Module['onTerminalError']>
export const onTerminalSessionsDelta: Module['onTerminalSessionsDelta'] = (...args) =>
  terminalsDouble.onTerminalSessionsDelta(...args) as ReturnType<Module['onTerminalSessionsDelta']>
export const onTerminalPromptUndelivered: Module['onTerminalPromptUndelivered'] = (...args) =>
  terminalsDouble.onTerminalPromptUndelivered(...args) as ReturnType<Module['onTerminalPromptUndelivered']>
export const openTerminal: Module['openTerminal'] = (...args) =>
  terminalsDouble.openTerminal(...args) as ReturnType<Module['openTerminal']>
export const resumeTerminal: Module['resumeTerminal'] = (...args) =>
  terminalsDouble.resumeTerminal(...args) as ReturnType<Module['resumeTerminal']>
export const setTerminalVisible: Module['setTerminalVisible'] = (...args) =>
  terminalsDouble.setTerminalVisible(...args) as ReturnType<Module['setTerminalVisible']>
export const resizeTerminal: Module['resizeTerminal'] = (...args) =>
  terminalsDouble.resizeTerminal(...args) as ReturnType<Module['resizeTerminal']>
export const terminalStatus: Module['terminalStatus'] = (...args) =>
  terminalsDouble.terminalStatus(...args) as ReturnType<Module['terminalStatus']>
export const listTerminals: Module['listTerminals'] = (...args) =>
  terminalsDouble.listTerminals(...args) as ReturnType<Module['listTerminals']>
export const suspendTerminal: Module['suspendTerminal'] = (...args) =>
  terminalsDouble.suspendTerminal(...args) as ReturnType<Module['suspendTerminal']>
export const closeTerminal: Module['closeTerminal'] = (...args) =>
  terminalsDouble.closeTerminal(...args) as ReturnType<Module['closeTerminal']>
export const setTerminalReapExempt: Module['setTerminalReapExempt'] = (...args) =>
  terminalsDouble.setTerminalReapExempt(...args) as ReturnType<Module['setTerminalReapExempt']>
export const configureTerminals: Module['configureTerminals'] = (...args) =>
  terminalsDouble.configureTerminals(...args) as ReturnType<Module['configureTerminals']>
export const takeUndeliveredPrompts: Module['takeUndeliveredPrompts'] = (...args) =>
  terminalsDouble.takeUndeliveredPrompts(...args) as ReturnType<Module['takeUndeliveredPrompts']>
export const ackTerminal: Module['ackTerminal'] = (...args) =>
  terminalsDouble.ackTerminal(...args) as ReturnType<Module['ackTerminal']>
export const writeTerminal: Module['writeTerminal'] = (...args) =>
  terminalsDouble.writeTerminal(...args) as ReturnType<Module['writeTerminal']>
export const terminalWritePieces: Module['terminalWritePieces'] = (...args) =>
  terminalsDouble.terminalWritePieces(...args) as ReturnType<Module['terminalWritePieces']>
export const resetTerminalsForTests: Module['resetTerminalsForTests'] = () => {
  terminalsDouble.resetTerminalsForTests()
}
