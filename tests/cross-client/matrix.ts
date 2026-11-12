import type { ClientId } from './client'
import { KNOWN_GAPS, NOT_RUN, ROWS, SCENARIO_WORDS, SCENARIOS, type ScenarioId } from './gaps'

// The gate's result: one row per client and scenario, read against the list
// of known gaps, and the table it prints.

type Outcome = { ok: true; ms: number } | { ok: false; ms: number; error: string } | { notRun: string }

export class Matrix {
  private readonly results = new Map<string, Outcome>()
  private readonly transports = new Map<ClientId, string>()
  private readonly simulated: Array<[ClientId | 'gate', string]> = []

  client(id: ClientId, transport: string, simulated: readonly string[]): void {
    this.transports.set(id, transport)
    for (const line of simulated) this.simulated.push([id, line])
  }

  simulate(line: string): void {
    this.simulated.push(['gate', line])
  }

  /** Run one row and record it; never throws. Answers whether it passed. */
  async run(client: ClientId, scenario: ScenarioId, work: () => Promise<unknown>): Promise<boolean> {
    if (!ROWS[client].includes(scenario)) throw new Error(`${client} is not held to ${scenario}`)
    const started = Date.now()
    try {
      await work()
      this.results.set(`${client}:${scenario}`, { ok: true, ms: Date.now() - started })
      console.log(`ok - ${client}: ${scenario}`)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.results.set(`${client}:${scenario}`, { ok: false, ms: Date.now() - started, error: message })
      const gap = KNOWN_GAPS[`${client}:${scenario}`]
      console.log(`${gap ? 'known gap' : 'not ok'} - ${client}: ${scenario}\n    ${message.split('\n')[0]}`)
      return false
    }
  }

  /** A whole client the gate could not run here, and why. */
  notRun(client: ClientId, why: string): void {
    for (const scenario of ROWS[client]) this.results.set(`${client}:${scenario}`, { notRun: why })
    console.log(`not run - ${client}: ${why}`)
  }

  /** Print the table, the gaps, what is simulated and what is not run. Answers the exit code. */
  report(options: { requireAll: boolean; stopped?: boolean }): number {
    const problems: string[] = []
    const cell = (client: ClientId, scenario: ScenarioId): string => {
      if (!ROWS[client].includes(scenario)) return '-'
      const outcome = this.results.get(`${client}:${scenario}`)
      const gap = KNOWN_GAPS[`${client}:${scenario}`]
      if (!outcome) {
        if (!options.stopped) problems.push(`${client}: ${scenario} never ran`)
        return options.stopped ? 'not reached' : 'MISSING'
      }
      if ('notRun' in outcome) {
        if (options.requireAll) problems.push(`${client}: ${scenario} was not run (${outcome.notRun})`)
        return 'not run'
      }
      if (outcome.ok && gap) {
        problems.push(`${client}: ${scenario} now passes: remove it from KNOWN_GAPS (tests/cross-client/gaps.ts)`)
        return 'PASSES (stale gap)'
      }
      if (outcome.ok) return 'ok'
      if (gap && gap.expect.test(outcome.error)) return 'known gap'
      if (gap) {
        problems.push(`${client}: ${scenario} failed, but not as its known gap says it does: ${outcome.error}`)
        return 'FAILED'
      }
      problems.push(`${client}: ${scenario}: ${outcome.error}`)
      return 'FAILED'
    }
    const clients = [...new Set<ClientId>(['desktop', 'peer', 'phone', 'embed', 'ssh'])]
    const header = ['client', 'transport', ...SCENARIOS]
    const rows = clients.map((client) => [
      client,
      this.transports.get(client) ?? '',
      ...SCENARIOS.map((scenario) => cell(client, scenario)),
    ])
    const widths = header.map((_, column) => Math.max(...[header, ...rows].map((row) => row[column].length)))
    const line = (row: string[]) => row.map((value, column) => value.padEnd(widths[column])).join('  ')
    console.log(`\nCross-client gate\n\n${line(header)}\n${widths.map((width) => '-'.repeat(width)).join('  ')}`)
    for (const row of rows) console.log(line(row))

    console.log('\nScenarios')
    for (const scenario of SCENARIOS) console.log(`  ${scenario}: ${SCENARIO_WORDS[scenario]}`)
    console.log('\nKnown gaps (each closes with the change named; the gate fails once one passes)')
    for (const [row, gap] of Object.entries(KNOWN_GAPS)) {
      const outcome = this.results.get(row)
      const seen = outcome && 'error' in outcome ? ` [${outcome.error.split('\n')[0]}]` : ''
      console.log(`  ${row}: ${gap!.reason}. Closed by: ${gap!.closedBy}.${seen}`)
    }
    console.log('\nSimulated (said here so nobody reads this gate as more than it is)')
    for (const [who, what] of this.simulated) console.log(`  ${who}: ${what}`)
    console.log('\nNot run on this runner')
    for (const entry of NOT_RUN) console.log(`  ${entry.what}: ${entry.why}.\n    By hand: ${entry.manual}`)
    for (const [row, outcome] of this.results)
      if ('notRun' in outcome && row.endsWith(':create')) console.log(`  ${row.split(':')[0]}: ${outcome.notRun}`)

    if (options.stopped) problems.unshift('the gate stopped before every row ran (above)')
    if (problems.length) {
      console.log(`\nThe gate failed:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`)
      return 1
    }
    console.log('\nThe gate passed.')
    return 0
  }
}
