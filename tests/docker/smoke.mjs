// The harness's smoke check (`studio-docker.mjs smoke <stack>`): for each
// desktop in the stack, connect over CDP, open the window, start a chat in the
// demo project on the stand-in agent, send a message and wait for its reply.
// Then what the topology adds: the SSH machine answers the desktop's key, and
// paired desktops see each other's Studio on the stand-in tailnet.
//
// playwright-core comes from the checkout's node_modules (npm ci).

import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const REPLY_MS = 60_000

function exec(container, command) {
  const run = spawnSync('docker', ['exec', '-u', 'tester', container, 'sh', '-c', command], { encoding: 'utf8' })
  return { ok: run.status === 0, out: `${run.stdout}${run.stderr}`.trim() }
}

/** The primary window of the desktop behind `cdp`. */
async function primaryWindow(chromium, cdp) {
  const browser = await chromium.connectOverCDP(cdp)
  for (let tries = 0; tries < 60; tries += 1) {
    const page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((each) => each.url().includes('windowId=primary'))
    if (page) return { browser, page }
    await new Promise((done) => setTimeout(done, 500))
  }
  throw new Error('no primary window')
}

async function clickIfVisible(locator) {
  if (await locator.isVisible().catch(() => false)) await locator.click()
}

/**
 * New chat, on the stand-in agent, in the demo project, one message, and its
 * reply. `web` picks the folder in the web client's own folder picker; a
 * desktop's Open Folder answers it without a dialog.
 */
async function chatOnce(page, message, { web = false } = {}) {
  // A first launch with no agent CLI it knows asks to set one up; the stand-in is installed.
  await clickIfVisible(page.getByRole('button', { name: 'Not now' }))
  await page.getByRole('button', { name: 'New chat', exact: true }).first().click()
  await clickIfVisible(page.getByRole('button', { name: 'Start as a conversation instead of terminal' }))
  const engine = page.getByRole('button', { name: /^Engine: / }).first()
  await engine.waitFor({ timeout: 15_000 })
  if ((await engine.getAttribute('aria-label')) !== 'Engine: OpenCode') {
    // The picker: a provider column, then that provider's runtimes.
    await engine.click()
    await page.getByRole('radio', { name: 'OpenCode', exact: true }).click()
    await page
      .getByRole('option', { name: /OpenCode/ })
      .first()
      .click()
  }
  const chooseProject = page.getByRole('button', { name: 'Choose a project' })
  if (await chooseProject.isVisible().catch(() => false)) {
    await chooseProject.click()
    // Open Folder answers /data/projects/demo (SPRINTENGINE_TEST_OPEN_DIR, set by the harness).
    await page.getByText('Browse…').first().click()
    if (web) {
      const path = page.getByRole('dialog').getByRole('textbox').first()
      await path.fill('/data/projects/demo')
      await path.press('Enter')
      await page.getByRole('button', { name: 'Choose this folder' }).click()
    }
  }
  // The composer is a CodeMirror editor.
  await page.locator('.cm-content:visible').last().click()
  await page.keyboard.type(message)
  await page.keyboard.press('Enter')
  await page.getByText(`you said "${message}"`, { exact: false }).first().waitFor({ timeout: REPLY_MS })
}

export async function smoke(info, pairingLink) {
  let chromium
  try {
    ;({ chromium } = require('playwright-core'))
  } catch {
    throw new Error('playwright-core is not installed: run npm ci in the checkout first.')
  }
  const shots = mkdtempSync(join(tmpdir(), 'studio-docker-smoke-'))
  const results = []
  const step = async (name, run) => {
    try {
      await run()
      results.push(true)
      console.log(`ok - ${name}`)
    } catch (error) {
      results.push(false)
      console.log(
        `not ok - ${name}\n  ${String(error?.message ?? error)
          .split('\n')
          .slice(0, 4)
          .join('\n  ')}`,
      )
    }
  }

  for (const desktop of info.desktops) {
    await step(`${desktop.name}: the window opens over CDP and a stand-in chat answers`, async () => {
      const { browser, page } = await primaryWindow(chromium, desktop.cdp)
      try {
        await chatOnce(page, `smoke check ${Date.now().toString(36)}`)
      } catch (error) {
        const shot = join(shots, `${desktop.name}.png`)
        await page.screenshot({ path: shot }).catch(() => undefined)
        throw new Error(`${error.message}\n(screenshot: ${shot})`)
      } finally {
        await browser.close()
      }
    })
    await step(`${desktop.name}: Studio's tailnet listener answers on the server port`, async () => {
      const health = await (await fetch(`${desktop.server}/tailnet/v1/health`)).json()
      if (!String(health.product).startsWith('SprintEngine Studio')) throw new Error(JSON.stringify(health))
    })
  }

  if (info.server) {
    await step('server: a browser pairs by link, and a stand-in chat answers in the web client', async () => {
      let browser
      try {
        browser = await chromium.launch()
      } catch (error) {
        throw new Error(`No browser to launch (npx playwright-core install chromium): ${error.message.split('\n')[0]}`)
      }
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
      try {
        await page.goto(pairingLink(info.server.container))
        await chatOnce(page, `smoke check ${Date.now().toString(36)}`, { web: true })
      } catch (error) {
        const shot = join(shots, 'server.png')
        await page.screenshot({ path: shot }).catch(() => undefined)
        throw new Error(`${error.message}\n(screenshot: ${shot})`)
      } finally {
        await browser.close()
      }
    })
  }

  if (info.sshMachine) {
    const desktop = info.desktops[0]
    await step('the SSH machine admits the desktop by its key', async () => {
      // No known_hosts entry is written: the app's own trust dialog still asks.
      const run = exec(
        desktop.container,
        'ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR dev@build-box "cd proj && git log --oneline | head -1"',
      )
      if (!run.ok || !/Initial files/u.test(run.out)) throw new Error(run.out)
    })
  }

  if (info.desktops.length > 1) {
    for (const desktop of info.desktops) {
      await step(`${desktop.name}: sees every other desktop's Studio on the stand-in tailnet`, async () => {
        const status = JSON.parse(exec(desktop.container, 'tailscale status --json').out)
        for (const peer of Object.values(status.Peer)) {
          const run = exec(desktop.container, `curl -s -m 5 http://${peer.TailscaleIPs[0]}:8471/tailnet/v1/health`)
          if (!run.out.includes('SprintEngine Studio')) throw new Error(`${peer.HostName}: ${run.out || 'no answer'}`)
        }
      })
    }
  }

  const failed = results.filter((ok) => !ok).length
  console.log(failed ? `${failed} of ${results.length} failed` : `all ${results.length} passed`)
  if (failed) process.exitCode = 1
}
