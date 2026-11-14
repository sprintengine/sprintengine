# The Studio server in WSL: the manual checklist

These checks need a real Windows PC with WSL 2. Every WSL distribution's
chats run on a Studio server inside it: there is no switch and no
one-process-per-chat path (design-wsl-ssh-direct PR 3c). The phase 7 spec asks
for this checklist (`docs/design/studio-server/phase-7-wsl-server.md`, section
9.3); this file turns it into steps. Owner ruling 2026-10-02 (decision R72):
the checklist is run by hand, and a self-hosted Windows runner with WSL 2 runs
it once one exists. Run it before the feature branch that made WSL
distributions direct environments merges to `main`.

None of it can run on the hosted CI runners, which have no nested
virtualisation and so no WSL 2. Everything that can run without WSL already
runs on every commit, with a plain `sh` standing in for `wsl.exe`
(`src/server/wsl/*.test.ts`, `src/main/hosts/wsl-install.test.ts`).

Each step says what to do and, after **Expect:**, what you should see. Record
each result in the release notes of the release it gates: pass, or fail with
what you saw instead. Include the build and the output of `wsl --version`.

Commands marked **PowerShell** run in a Windows terminal. Commands marked
**distro** run in a shell inside the distribution (`wsl -d Ubuntu-24.04`).

## Set-up

1. Windows 11 with current updates. **PowerShell:** `wsl --version`.
   **Expect:** a WSL version line and a kernel version. If `wsl -l -v` shows
   VERSION 1 for the test distribution, convert it first.
2. **PowerShell:** `wsl --install -d Ubuntu-24.04`, then create the user.
   **distro:** install at least one agent CLI and sign it in (`claude`,
   `codex`). **Expect:** `claude --version` (or `codex --version`) prints a
   version.
3. **PowerShell:** `wsl --install -d Debian`, for the isolation checks.
4. Install the build under test with its installer, not a dev build.
   **Expect:** `%LOCALAPPDATA%\Programs\sprintengine-studio\resources\wsl-server\server.cjs`
   and `build.json` exist.
   - To use a dev build instead, run `npm run build:server:wsl` first. If you
     skip it, a chat on the server fails with "this build shipped without the
     Studio server for WSL".
5. Know where the logs are.
   - Windows: `%APPDATA%\sprintengine-studio\logs\diagnostics-YYYY-MM-DD.jsonl`.
     Search for `WSL server`.
   - **distro:** the server's own log,
     `~/.local/state/sprintengine-studio/logs/data/server-YYYY-MM-DD.log`
     (`data-<id>/` for a nightly or a pinned profile, as for its data). A day's
     file stops at 10 MB and the next part begins (`server-YYYY-MM-DD.1.log`);
     fourteen days are kept.
   - **distro:** the server's data is in
     `~/.local/share/sprintengine-studio/data/` (`data-<id>/` for a nightly
     or a pinned profile).
6. In the app, add a workspace inside the distribution:
   `\\wsl.localhost\Ubuntu-24.04\home\<you>\repo` (any git repository).

## A. The hand-over from the last release, and a first chat

Before installing the build under test, with the last release (whose WSL
chats ran one process per chat through `wsl.exe`), make three WSL chats and
leave them: one in `\\wsl.localhost\Ubuntu-24.04\home\<you>\repo`, one in a
`C:\` workspace bound to WSL: Ubuntu-24.04, and one in a folder outside your
home (`\\wsl.localhost\Ubuntu-24.04\srv\repo`). In each: attach a picture,
let a tool return a picture (a screenshot), accept a plan, and answer an
approval with "Always allow". Schedule a message for tomorrow in one, and
watch a pull request in another if you can.

1. Install the build under test and start it.
   **Expect:** **distro:** `ps -ef | grep server.cjs` shows one server
   within a few seconds, with no chat opened: a distribution with chats is
   started at the desktop's start. Windows' diagnostics log has no
   "kept its own" line for these chats.
   Repeat once with a fresh copy of the last release's data: quit the app
   within a few seconds of its start, while the hand-over is running (the
   distribution's server log shows `environment.adopt` calls), and start it
   again. **Expect:** the same as above, and each chat listed once in step 2.
2. Open each of the three chats.
   **Expect:** the whole transcript, both pictures, the plan (open it), and
   the folder as before. The sidebar places each where it was.
3. Send a message in each.
   **Expect:** a reply. **distro:** `ps -ef | grep -E 'claude|codex'`: the
   agents run in the distribution, children of `server.cjs`, with the
   Studio tools listed (ask the agent). **PowerShell:** no `claude`/`node`
   process for them on Windows, and no `wsl.exe` per chat:
   `Get-CimInstance Win32_Process -Filter "Name='wsl.exe'" | Select CommandLine`
   shows none with `eval $(echo`.
4. Repeat the approved action in each.
   **Expect:** not asked again (the saved approval moved with the chat).
   Settings › approvals on the desktop no longer lists it; it is the
   distribution's now.
5. **Expect:** the scheduled message is listed under the chat, and is sent
   when due while the app runs.
6. **distro:** `ls ~/.local/share/sprintengine-studio/data/environment-adoptions/parts/*/`.
   **Expect:** empty or absent.
7. Settings › Machines › WSL: Ubuntu-24.04: expand it.
   **Expect:** no "Chats run in" control. A "Studio server" row reads
   "Running, reached over loopback."
8. Start a new chat in the workspace and send a message.
   **Expect:** a reply; still exactly one server process.
9. In a chat, attach an image to a message, open a tool's details, revert a
   turn, and use "Edit from here" and "Fork from here".
   **Expect:** each works as it does for a chat on Windows.
10. Quit the app.
    **Expect:** within ten seconds, **distro:** `ps -ef | grep server.cjs`
    shows nothing. Start the app and send in the same chat.
    **Expect:** the chat resumes.
11. On the paired phone (or a paired desktop), open the distribution's
    chats under this desktop.
    **Expect:** they are listed with the WSL mark, and a message sent from
    the phone gets a reply. The phone has no terminal for them.

## B. Transports and the front door (spec V1, V3)

1. NAT mode, which is the default. Start a server chat.
   **Expect:** the Studio server row says "over loopback". Write down the
   time from sending to the first reply.
2. **distro:** `ss -ltnp | grep node`.
   **Expect:** the server's port is bound to `127.0.0.1` only. Never
   `0.0.0.0`, `*` or `[::]`.
3. Add `localhostForwarding=false` under `[wsl2]` in
   `%USERPROFILE%\.wslconfig`. **PowerShell:** `wsl --shutdown`. Send in a
   server chat.
   **Expect:** the chat works. The row says "Running, reached through the
   stdio bridge." with the reason loopback did not work.
4. Remove that line. Set `networkingMode=mirrored` under `[wsl2]`.
   **PowerShell:** `wsl --shutdown`. Send in a server chat.
   **Expect:** "over loopback" again. Repeat step 2 and get the same result.
   **PowerShell:** `Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq <port>`.
   **Expect:** only `127.0.0.1`, never `0.0.0.0` or a LAN address.
5. Check that the door refuses a stranger. With a server running, find its
   port (step 2). **PowerShell:**
   `$c = New-Object Net.Sockets.TcpClient('127.0.0.1', <port>); $s = $c.GetStream(); $w = New-Object IO.StreamWriter($s); $w.WriteLine('{"t":"hello"}'); $w.Flush(); Start-Sleep 1; $c.Close()`.
   **Expect:** in the distribution's server log, a line "Refused a connection
   on the loopback door". Chats keep working.
6. V3 is informational: what Windows reaches when a Windows process already
   holds the port. **PowerShell:** `python -m http.server 50123 --bind 127.0.0.1`.
   **distro:** `python3 -m http.server 50123 --bind 127.0.0.1`.
   **PowerShell:** `curl.exe http://127.0.0.1:50123/`. Write down which one
   answered. Either answer is safe, because the proof refuses a decoy
   (`front-door.test.ts`).
7. Set "How Windows reaches it" to "Always the bridge" and quit and restart
   the app. Send in a server chat.
   **Expect:** the row says "through the stdio bridge". Repeat step 2.
   **Expect:** no listening port for the server.

## C. Lifetime (spec V2, V9)

1. Leave the app idle, with no chat working, for ten minutes.
   **Expect:** **distro:** `ps -ef | grep server.cjs` shows nothing. The row
   says the server starts with the first chat.
2. Start a long reply. Mid-reply, **PowerShell:** `wsl --shutdown`.
   **Expect:** the turn shows as interrupted, and the row says "WSL was shut
   down…". **PowerShell:** `wsl -l -v` still shows the distribution
   `Stopped` a minute later, because nothing restarted it. Send again.
   **Expect:** the VM starts, then the server, and the chat resumes.
3. Mid-reply, **distro:** `kill -9 <pid of server.cjs>`.
   **Expect:** the row says "stopped unexpectedly". Send within two seconds.
   **Expect:** told when it is tried again. Send a few seconds later.
   **Expect:** the server restarts and replies.
4. Sleep the PC mid-reply, wake it, and send again.
   **Expect:** a reply, from the same server or a restarted one.
5. V2 is informational. With the app quit, start a server by hand in the
   distribution, close the `wsl.exe` window that started it, and check
   whether the VM stays up (`wsl -l -v`). The design does not rely on it.

## D. Files, git and `C:\` (spec V4, V5)

1. Open New chat on a workspace in `C:\` bound to WSL: Ubuntu-24.04.
   **Expect:** "On C: — slow from Ubuntu-24.04. Run on This PC for full
   speed." under the scope line. The chat still starts.
   **distro:** `ps -ef | grep -E 'claude|codex'`.
   **Expect:** its working directory is under `/mnt/c/...`.
2. V4: in a repository of about 50,000 files, time `git status` and a
   mention search three ways: on ext4 through the server, on `/mnt/c`
   through the server, and natively on `C:\` on This PC.
   Write the three numbers down.
   Then run `git status` once from PowerShell in the `C:\` repository (so
   Git for Windows writes the index) and open the Git pane of its WSL
   workspace.
   **Expect:** the pane fills in about as fast as for a Windows workspace,
   not after tens of seconds (R89).
3. V5: with the Windows-side workspace open, run a server chat on `/mnt/c`
   for several turns.
   **Expect:** the chat list and the transcript stay intact, with no
   duplicated or missing turns.
4. Open New chat, pick a project inside the distribution
   (`\\wsl.localhost\Ubuntu-24.04\home\dev\repo`), and pick "This PC
   (Windows)" in the machine list.
   **Expect:** the machine can be picked, with "In Ubuntu-24.04 — slow from
   Windows. Run on WSL: Ubuntu-24.04 for full speed." under the scope line.
   Send a message.
   **PowerShell:** `Get-CimInstance Win32_Process -Filter "Name like 'claude%' or Name like 'node%'" | Select ProcessId, CommandLine`.
   **Expect:** the agent runs on Windows, and asked for its working
   directory it answers the `\\wsl.localhost\…` folder. The Git pane shows
   the repository's branch and changes, with no "dubious ownership" error,
   and `git config --global --get-all safe.directory` is unchanged. A
   terminal opened in the chat starts in the same folder.
5. In the same New chat, pick WSL: Ubuntu-24.04 again, then a second
   distribution if one is enabled.
   **Expect:** the second distribution is greyed out with "WSL: <name>
   cannot open a folder inside Ubuntu-24.04." With WSL: Ubuntu-24.04
   picked, choose Browse… for the project.
   **Expect:** the folder dialog opens at
   `\\wsl.localhost\Ubuntu-24.04\home\<you>\Documents`, or at
   `…\home\<you>` when there is no Documents folder (the distribution's own
   Studio says where).
6. **distro:** add `[automount]` and `root = /win/` to `/etc/wsl.conf`.
   **PowerShell:** `wsl --terminate Ubuntu-24.04`. Send in a `C:\`
   workspace's server chat.
   **Expect:** the agent runs under `/win/c/...`.
7. Change that section to `enabled = false` and terminate the distribution
   again. Send in the `C:\` workspace's server chat.
   **Expect:** the chat is refused with a message saying automount is off in
   `/etc/wsl.conf`. Remove the section afterwards.

## E. Agents, tools and sign-in (spec V7, V10)

1. In a server chat, ask the agent to list Studio's tools.
   **Expect:** the core's tools, plus `browser` and `canvas`.
2. Ask the agent to open a page in the browser pane.
   **Expect:** the Windows pane opens it.
3. Out of process (section G), ask the agent to open
   `/home/<you>/repo/README.md` in the editor, then `~/repo/README.md`.
   **Expect:** the first opens the file in the Windows editor. The second is
   refused with a message asking for the absolute path.
4. Install a CLI with nvm or into `~/.local/bin`, quit the app, start it,
   and use that CLI in a server chat.
   **Expect:** it is found. The login environment is read once, when the
   server starts.
5. V10: **distro:** sign each CLI out. Sign in again from a server chat.
   **Expect:** the sign-in works and the next message replies.
6. V7: behind a corporate VPN, or with `HTTPS_PROXY` set in `~/.profile`,
   send in a server chat.
   **Expect:** the chat reaches its provider.

## F. Isolation, versions and data (spec 8.6–8.11, V8)

1. Run a chat in Ubuntu-24.04 and one in Debian at once.
   **Expect:** two servers and two data directories. **distro (Debian):**
   kill its server. **Expect:** the Ubuntu chat keeps working.
2. On a spare distribution with a chat, **PowerShell:**
   `wsl --set-version <name> 1`, then send in that chat.
   **Expect:** refused with "Convert it with "wsl --set-version <name> 2""
   (decision R70: WSL 1 chats are no longer run one process each).
3. **PowerShell:** `wsl --unregister` a spare distribution with a chat, then
   send in that chat.
   **Expect:** a readable message saying the distribution is not installed,
   with no stray characters between the letters.
   Quit and start the app with that chat still in the sidebar (and again with
   the WSL 1 distribution of step 2).
   **Expect:** the chat says why. Windows' diagnostics log has one attempt
   for each at the start, and later ones only as the open chat retries, ever
   further apart; `wsl -l -v` never shows the WSL 1 distribution `Running`.
4. V8: **PowerShell:** `wsl --manage <distro> --set-default-user <other>`,
   then send in a server chat.
   **Expect:** the server runs as the new user, in that user's home, with its
   own data. Chats made as the old user stay in the old user's home.
5. Upgrade: with a server running, install the next build and send a
   message.
   **Expect:** `server-<new>/` appears beside the old tree. The old tree is
   pruned on a later install, once nothing runs from it. `data/` is
   untouched.
6. Run the installed build and a nightly side by side, and send in a WSL
   chat in each.
   **Expect:** two servers, one on `data/` and one on `data-<id>/`, and both
   reply.

## G. Out of process

1. Settings: turn on "Run Studio server in its own process" and restart.
2. Open a WSL chat and send a message.
   **Expect:** it replies: the desktop's server process supervises the
   distribution's server as the app does in process.
3. Open Settings › Machines.
   **Expect:** the "Studio server" row for each distribution, as in process.

## H. Files, Git and terminals of a WSL workspace

1. In a `\\wsl.localhost\…` workspace, open the Files pane, open and save a
   file, and open the Git pane: stage, commit, and look at a diff.
   **Expect:** each works; **distro:** the commit is there. (The panes ask
   the distribution's own Studio for a folder in its share.)
2. Do the same in a `C:\` workspace bound to the distribution.
   **Expect:** each works (this desktop reads the drive; its git runs in the
   distribution, decision R89).
3. Open a terminal in a WSL workspace, and start an agent in a terminal.
   **Expect:** a Linux shell in the workspace's folder; the agent's state
   (working, waiting) shows in the sidebar.
4. Close the window that holds a WSL chat and reopen it.
   **Expect:** the chat reconnects; in the distribution's server log, the
   closed window's connection ended.

## I. Defender (spec V11)

1. With real-time protection on, in a fresh distribution, time the first
   install and the first chat. The install is the Node
   download, then the server tree.
   **Expect:** both finish. Write the times down.

## Throughput

1. Over loopback, and again over the bridge, send a 10 MiB image and open a
   tool detail of about 64 MiB.
   **Expect:** both arrive each way. Write down how long each took.
