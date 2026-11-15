// Logins in containers (docs/design/container-chats.md): one Docker volume per
// Docker host, mounted in every container Studio makes there, holding every
// agent's login and the git and GitHub credentials. A person signs in once on
// a host, inside a container, with each CLI's own login; every other container
// on that host, and one made again from a new image, has it. Nothing on the
// host is ever copied in.
//
// Each CLI is pointed into the volume by its own variable, set on the
// container, so every process in it (Studio's server, an agent, a terminal)
// finds the same logins. Read from where each CLI really writes inside the
// image:
//
//   Claude Code   CLAUDE_CONFIG_DIR          its .credentials.json and .claude.json
//   Codex         CODEX_HOME                 auth.json
//   Grok          GROK_HOME                  its credentials
//   OpenCode      XDG_DATA_HOME/opencode     auth.json
//   Cursor        XDG_CONFIG_HOME/cursor     its CLI config and login
//   Muse          XDG_CONFIG_HOME/muse       auth.json
//   Kimi Code     ~/.kimi-code               a link into the volume (LOGINS_HOME_LINKS)
//   GitHub CLI    XDG_CONFIG_HOME/gh         hosts.yml
//   git           XDG_CONFIG_HOME/git        config (gh as the credential helper for GitHub)

/** The volume's name on every host. */
export const LOGINS_VOLUME = 'sprintengine-logins'
/** The label it carries: Studio's, and never removed with a container. */
export const LOGINS_LABEL = 'sprintengine.studio.logins'
/** Where it is mounted inside every container. */
export const LOGINS_ROOT = '/studio-logins'

/** The variables every container is started with, pointing each CLI into the volume. */
export const LOGINS_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CONFIG_DIR: `${LOGINS_ROOT}/claude`,
  CODEX_HOME: `${LOGINS_ROOT}/codex`,
  GROK_HOME: `${LOGINS_ROOT}/grok`,
  XDG_CONFIG_HOME: `${LOGINS_ROOT}/config`,
  XDG_DATA_HOME: `${LOGINS_ROOT}/data`,
}

/**
 * The CLIs that keep their login under the home and read no variable for it:
 * each such folder in the home is a link into the volume (`.kimi-code` →
 * `kimi-code`), made once the container is made or made again
 * (`prepareLoginsScript`).
 */
export const LOGINS_HOME_LINKS: Readonly<Record<string, string>> = {
  '.kimi-code': 'kimi-code',
}

/**
 * Files the volume starts with, written only where none is there yet, once a
 * container is made or made again (a volume made by an older image has none
 * of a newer one's):
 * Claude Code's first-run answers, and git's use of the GitHub CLI for GitHub.
 * Neither holds a credential.
 */
export const LOGINS_SEEDS: Readonly<Record<string, string>> = {
  'claude/.claude.json': '{"hasCompletedOnboarding":true,"bypassPermissionsModeAccepted":true}\n',
  'config/git/config': [
    '[credential "https://github.com"]',
    '\thelper =',
    '\thelper = !/usr/local/bin/gh auth git-credential',
    '[credential "https://gist.github.com"]',
    '\thelper =',
    '\thelper = !/usr/local/bin/gh auth git-credential',
    '',
  ].join('\n'),
}
