# Slack Copilot

Slack Copilot watches your Slack messages, sorts them by how urgent they are, and
tells you which ones actually need you. It runs quietly on your Mac.

Once it is installed you never have to start it. It is simply there: a small
speech-bubble icon at the top right of your screen, next to the clock.

---

## Installing it

1. Open the **Slack Copilot** folder.
2. Double-click the file called **install.command**.
   (If your Mac hides file endings, it will look like just **install**.)
3. A black window opens and shows what it is doing. The first time, it may take a
   few minutes. You can leave it alone.
4. When it says **Done**, press Return to close that window.

That's it. Slack Copilot is now in your Applications folder, it is running, and it
will start again by itself every time you log in.

### The first time you open it, your Mac may warn you

Because this app was made in-house rather than bought from the App Store, macOS
may put up a grey box that says something like:

> **"Slack Copilot" cannot be opened because it is from an unidentified developer.**
> macOS cannot verify that this app is free from malware.

That is normal and expected. To get past it, once and only once:

1. Click **Done** or **Cancel** to dismiss the box.
2. Open your **Applications** folder (in Finder, choose Go → Applications).
3. Hold down the **Control** key and click **Slack Copilot**.
4. Choose **Open** from the little menu that appears.
5. A similar box appears, but this one has an **Open** button. Click it.

From then on it opens normally and you will never see that box again.

If instead you see a box offering **Open System Settings**, click it, scroll down
to where it says *"Slack Copilot" was blocked*, and click **Open Anyway**.

---

## Using it

**The speech bubble at the top of your screen is the way in.**

| What you see | What it means |
|---|---|
| A filled speech bubble | Everything is working. |
| A bubble with a number next to it, like `3` | 3 urgent messages are waiting for you. |
| A hollow bubble | It is still starting up. Give it a few seconds. |
| A crossed-out bubble with a `!` | Something is wrong. Click the bubble for the reason. |

- **Click the bubble** to open the Slack Copilot window.
- **Right-click the bubble** for the menu: it tells you in plain words how things
  are going, and lets you close the app or stop it starting automatically.

**Closing the window does not switch it off.** It keeps watching in the
background — that is the point. To switch it off completely, right-click the
bubble and choose **Quit Slack Copilot**.

### Notifications

When a genuinely urgent message arrives, your Mac shows a notification in the
corner of the screen. Click it and Slack Copilot opens straight to that message.

It is deliberately quiet:

- Only the most urgent messages ever cause a notification. Routine ones never do.
- The same conversation never notifies you twice.
- Installing it does not set off a pile of notifications about old messages.

If you are not seeing notifications, open the Slack Copilot window, then from the
menu at the very top of the screen choose **Slack Copilot → Send a test
notification**. If nothing appears, macOS is blocking them: open System Settings →
Notifications → Slack Copilot and switch **Allow notifications** on.

---

## When something looks wrong

Slack Copilot tells you rather than failing quietly. Right-click the speech
bubble and read the first line of the menu.

| It says | What is happening | What to do |
|---|---|---|
| Connected to *(your workspaces)* | All good. | Nothing. |
| Starting up… | It is waking up. | Wait a few seconds. |
| Disconnected from Slack — retrying | Slack or your internet dropped. | It reconnects on its own. If it stays like this, check your internet. |
| Not running — retrying… | The background part stopped and is being restarted. | Wait. If it does not clear, choose **Restart Slack Copilot**. |
| Slack is not set up yet | Your Slack sign-in details are missing. | Ask whoever set this up for you. |
| Can't sign in to Slack | Your Slack sign-in details have expired. | Ask whoever set this up for you. |
| Something else is using the connection this app needs | Another program has taken the door it uses. | Restart your Mac. |
| Slack Copilot can't find its files | The Slack Copilot folder was moved or renamed. | Open the folder and double-click **install.command** again. |

If you need to send someone the details, right-click the bubble and choose
**Show the activity log** — a Finder window opens with the files they will ask for.

### Closing your laptop, restarts, and crashes

- **Closing the lid** is fine. It pauses, and picks up where it left off when you
  open the lid again.
- **Restarting your Mac** is fine. It comes back by itself when you log in.
- **If the background part stops for any reason**, it restarts itself within a
  few seconds. If it keeps failing, the menu bubble changes to the crossed-out
  version so you can see it, instead of it just going quiet.

---

## Removing it

Double-click **uninstall.command** in the Slack Copilot folder, type `remove`
when it asks, and press Return.

That removes the app and stops it starting automatically. It does **not** delete
the Slack Copilot folder, your Slack sign-in details, or the messages it has
already collected — so you can put it back later by running **install.command**
again.

---

## Where your information lives

Everything stays on this Mac.

- **Your Slack sign-in details** are in a file called `.env` inside the Slack
  Copilot folder. They are never sent anywhere except to Slack itself, and
  nothing else on your Mac can read them through the app.
- **The messages it has collected** are in a file called `data.db` in the same
  folder.
- **Its own notes about how it is running** are in Finder under
  Library → Logs → Slack Copilot. Those never contain your sign-in details.

The window you look at is served from your own Mac. Nothing about it is on the
internet, and no one else can open it.

---

<details>
<summary><b>For whoever set this up (technical notes)</b></summary>

### What the app actually is

An Electron shell around the existing server. It does **not** re-implement or
import anything from `src/` — it spawns the project's own entry point as a child
process:

```
node --import tsx <projectDir>/src/index.ts --copilot-managed
```

so the packaged app always runs whatever is currently in `src/`, picks up `.env`
and `data.db` from the project directory, and can never drift from the dev setup.
`npm run dev` is unaffected and still works exactly as before.

### Commands

```bash
npm run app:build    # builds release/mac-arm64/Slack Copilot.app
npm run app:dev      # runs the shell from source, without packaging
npm run app:icons    # regenerates assets/ from code (no binary assets in git)
```

### Behaviour worth knowing

- **Port sharing.** On startup the app probes `127.0.0.1:5252`. If a Slack Copilot
  server is already answering (e.g. someone's `npm run dev`), it *attaches* to it,
  never spawns a second one, and never kills it on quit. If nothing is there it
  starts and supervises its own, restarting with backoff (1s → 60s) on exit. A
  server it started in a previous run that outlived the app is recognised by the
  `--copilot-managed` marker on its command line and adopted; a dev server can
  never match that.
- **Auth.** `/api/*` still requires `x-copilot-token`. The app obtains it the same
  way the page does — fetching `/` and reading the injected value. No auth was
  weakened, and the token is never logged or written to disk.
- **Deep links.** Clicking a notification loads `http://127.0.0.1:5252/#/t/<id>`.
  Keep the UI reading that hash at startup and notification clicks keep working.
- **Node discovery.** GUI apps launched at login get a minimal `PATH`, so the app
  looks for Node in `/opt/homebrew/bin`, `/usr/local/bin`, `/opt/local/bin`,
  `/usr/bin` (newest with major ≥ 22, for `node:sqlite`), and borrows the login
  shell's `PATH` for the child so the analyzer can find the `claude` CLI.
- **Signing.** The bundle is ad-hoc signed (`codesign --sign -`). It is not
  notarised, hence the first-open dialog documented above.
- **Login item.** `app.setLoginItemSettings({ openAtLogin: true })` on first run,
  re-applied automatically after a reinstall (replacing the bundle drops the
  registration), but not overridden if it was turned off deliberately.

### Files

```
electron/          the Mac app (main process, waiting screen, builder config)
scripts/           icon generation and the build
assets/            generated icons — safe to delete, regenerated by the build
install.command    double-click installer
uninstall.command  double-click uninstaller
```

Build output lives in `release/` and `electron/assets/` +
`electron/project-path.json`; all are generated and should be git-ignored.

</details>
