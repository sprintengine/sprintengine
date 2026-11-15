import type { VersionControlProviderProbe } from '../../shared/version-control'
import { binaryVersionProbeFrom, parseProbeOutput, probeBinaryVersion } from '../../main/cli-runtime-install'
import { hostRegistry } from '../../main/hosts/host-registry'
import { sharedGhRunner, sharedHostCliRunner } from '../../main/github/gh'
import { probeHostGh } from '../../main/github/host-gh-status'
import { isWslHostId } from '../../shared/execution-host'
import type { HostGhStatus } from '../../shared/host-gh'
import {
  parseGhAuthLogin,
  parseGlabAuthLogin,
  parseTeaLogin,
  probeVersionControlProviders,
  type VersionControlProbeDeps,
} from '../../main/ipc/version-control-probe'

// The real probes: the same machinery agent-CLI detection uses for versions, and
// the same gh runner the review paths use for auth (so a GUI-launched app finds a
// Homebrew/nvm gh, and gh's own credential store is the single auth source).
function createVersionControlProbeDeps(): VersionControlProbeDeps {
  const gh = sharedGhRunner()
  return {
    probeVersion: (binary) => probeBinaryVersion(binary),
    async readGhLogin() {
      // A non-zero exit is gh's own "not logged in" verdict.
      const status = await gh.run(['auth', 'status'])
      if (!status.found || status.code !== 0) return null
      return parseGhAuthLogin(`${status.stdout}\n${status.stderr}`)
    },
    // Through the same runners the chat's Create PR drives them with, so the
    // row and the button find the same binary.
    async readForgeLogin(binary) {
      if (binary === 'glab') {
        const status = await sharedHostCliRunner('glab').run(['auth', 'status'], {
          timeoutMs: 15_000,
          setEnv: { NO_PROMPT: '1' },
        })
        return status.found ? parseGlabAuthLogin(`${status.stdout}\n${status.stderr}`) : null
      }
      const listed = await sharedHostCliRunner('tea').run(['logins', 'list', '--output=json'], { timeoutMs: 15_000 })
      return listed.found && listed.code === 0 ? parseTeaLogin(listed.stdout) : null
    },
    // Each enabled WSL machine's own git: the one a workspace on that machine
    // runs. Asked through the machine itself, so it is that distribution's
    // login PATH that answers.
    async listGitMachines() {
      const { hosts } = await hostRegistry().list()
      return hosts
        .filter((summary) => summary.kind === 'wsl')
        .map((summary) => ({
          hostId: summary.id,
          label: summary.label,
          async probeGit() {
            const outcome = await hostRegistry().get(summary.id).runCommand(['git', '--version'], { timeoutMs: 15_000 })
            // 127 is the shell's "command not found"; any other failure is the
            // distribution not answering, which is not a verdict about git.
            if (outcome.code === 127) return { outcome: 'not_installed' as const }
            if (outcome.timedOut || outcome.spawnFailed || outcome.code !== 0)
              return { outcome: 'probe_failed' as const }
            return binaryVersionProbeFrom({ parsed: parseProbeOutput(0, outcome.stdout), inconclusive: false })
          },
        }))
    },
  }
}

// What `versionControl.*` answers: the providers this machine has, probing
// exactly the ones the product integrates, so nothing a client sends reaches
// a spawn; and one WSL machine's `gh`, by its id and nothing else.
export function createVersionControl(deps: VersionControlProbeDeps = createVersionControlProbeDeps()) {
  return {
    probeProviders: (): Promise<VersionControlProviderProbe[]> => probeVersionControlProviders(deps),
    async probeHostGh(hostId: string): Promise<HostGhStatus | null> {
      if (!isWslHostId(hostId)) return null
      try {
        return await probeHostGh(hostRegistry().get(hostId))
      } catch {
        return null
      }
    },
  }
}
