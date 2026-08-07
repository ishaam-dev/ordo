# Slack Copilot

Slack Copilot watches your Slack messages, sorts them by how urgent they are, and
tells you which ones actually need you. It runs quietly on your Mac: a small
speech-bubble icon at the top right of your screen, next to the clock.

It exists because Slack has no idea what matters. Every DM and every `@you` looks
identical, so you either read everything or you miss the one that mattered. Slack
Copilot collects your DMs and mentions from one or two workspaces into a single
list, has Claude read each conversation and say *why* it matters and what it
thinks you should do, and lets you talk to Claude about any of them and send the
reply back to Slack with a click.

Everything runs on your Mac. Your messages are never sent to any server other than
Slack's and Claude's, and there is no account to make, no cloud to sign up for,
and no website to visit.

---

## Contents

- [Set it up with an AI agent](#set-it-up-with-an-ai-agent) ← start here
- [What you need before you start](#what-you-need-before-you-start)
- [Set it up by hand](#set-it-up-by-hand)
- [Using it, day to day](#using-it-day-to-day)
- [How it works](#how-it-works)
- [Privacy](#privacy)
- [Known limitations](#known-limitations)
- [When something looks wrong](#when-something-looks-wrong)
- [Removing it](#removing-it)

---

## Set it up with an AI agent

The whole setup is fiddly in a couple of places — Slack's command-line tool has an
authentication dance that involves pasting a slash command into Slack and reading a
code back out. So the intended way to install this is to let a coding agent do it
with you.

**Use Claude Code unless you already prefer something else.** It is what the app
uses out of the box and it is much the smoothest path: it runs on the Claude
subscription you are already signed in to, it can pull in context from the other
apps you have connected, and chat about a conversation carries on from the reading
the app has already done.

You can run it on a different assistant — **Pi** or **Codex** — and that is a single
choice, made once: whichever one you pick sets the app up now *and* reads your Slack
conversations afterwards. There is nothing else to install at the end. If you want
one of those, skim [Using a different AI agent](#using-a-different-ai-agent) below
first — it is one extra line in a file, and the agent will write that line for you.

If you don't have Claude Code yet: [install Claude Code](https://claude.com/claude-code),
then run `claude auth login` once.

You don't need to download this project first — the agent fetches it itself. Open a
terminal in whatever folder you keep projects in, start your assistant (type
`claude`, or `pi`, or `codex`), and paste the block below. Then just answer its
questions — it does everything else. Say yes when it asks permission to run commands
or edit files; it can't do the setup otherwise.

````text
You are setting up an app called "Slack Copilot" on my Mac.

The finished app runs an AI assistant of my choosing — that is what reads and rates
my Slack conversations. Claude Code is the default and the one to use unless I say
otherwise; the app also accepts "pi" and "codex". Ask me which one I want at STEP 0,
and if I don't have a preference, use Claude Code and tell me that's what you did.
Whichever I choose is the same assistant that has to be installed and signed in on
this Mac when we finish — so being signed in matters twice over: for you now, and
for the app afterwards.

The code lives at https://github.com/ishaam-dev/slack-copilot

Start by getting it. If the folder this session is open in already contains this
project (look for manifest.json and a src/ folder with analyzer.ts in it), use it.
Otherwise clone it: `git clone https://github.com/ishaam-dev/slack-copilot` and
work inside the folder it creates — tell me where you put it.
The repository is PRIVATE, so the clone only works if I've been given access to it
and my machine is signed in to GitHub. If the clone fails with a "not found" or
"authentication" error, don't guess or try workarounds — tell me plainly that I
need to be added to the repo, or need to sign in (`gh auth login`), and wait.

Read README.md, DESIGN.md, .env.example and src/config.ts first so you know what
the app is and what it needs. Then set it up with me.

Assume I am NOT a programmer. If you use a technical word, explain it in one plain
sentence first.

=== HOW TO WORK WITH ME (this matters more than speed) ===

1. ONE STEP AT A TIME. Do a step, check it actually worked, tell me in a sentence
   or two what happened, then go on to the next one. Never dump the whole plan on
   me. Never do three steps in one message. I want to be able to follow along.

2. RUN THE COMMANDS FOR ME. You have a terminal — use it. Installs, Slack CLI
   commands, creating files, editing files: you do them, I watch. Don't hand me a
   list of commands to type unless the command genuinely has to run somewhere I
   can't give you access to.

3. STOP AND WAIT AT MY STEPS. There are exactly four kinds of thing only I can do:
   pasting a slash command into Slack, approving a permissions box in Slack,
   reading a challenge code back to you, and copying two tokens out of a web page.
   At each one: tell me exactly what to click, give me the exact URL, then STOP and
   WAIT until I say I've done it. Do not guess, do not continue, do not pretend my
   part happened.

4. NEVER ASK ME TO PASTE A TOKEN INTO THIS CHAT. Slack tokens let whoever holds
   them read and send my messages. I will paste them straight into the .env file
   myself. You may check that a value starts with the right prefix and is roughly
   the right length — nothing else. Do not print, echo, log, copy or repeat the
   contents of .env, not even partially, not even to confirm.

5. VERIFY EVERY STEP with a real command, and when something fails, read the ACTUAL
   error text and diagnose from that. Don't assume it worked.

6. If a step needs a decision from me — which AI assistant, one workspace or two,
   which workspace is A — ask me.

=== WHAT WE ARE BUILDING ===

A local app that watches my Slack DMs and @-mentions, has an AI assistant rate how
urgent each conversation is, and shows them in one prioritized list on my Mac.

=== WHAT IT NEEDS (check or install each of these with me) ===

- Node 22 or newer. This is what the app runs on. If `node -v` is missing or too
  old, install it with `brew install node`. Homebrew puts Node in /opt/homebrew/bin,
  which isn't always on PATH — if a later command says "node: command not found",
  that's why.
- The AI assistant I chose, installed and signed in. The app hands each conversation
  to it, so this has to be true when we finish, not just right now.
    Claude Code (the default): `claude auth status` should say loggedIn true; if not,
      have me run `claude auth login`.
    Pi: install with `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`,
      sign in with `pi /login`.
    Codex: install with `npm install -g @openai/codex`, sign in with `codex login`.
  Signing in is mine to do, in a browser. This project has no API key of its own and
  you must never ask me for one — if my assistant wants a key, it reads it from my
  own environment and I put it there myself, never in this chat.
- A Slack app in EACH workspace I want to watch — one app per workspace, so one or
  two of them. These don't exist yet: you are going to create them.
  **Create them with the Slack command-line tool** (`slack app install`), from the
  manifest.json already in this repo. Do NOT walk me through the web form at
  api.slack.com to create an app — the CLI does it in one command and the web form
  has a fiddly failure mode.
  The CLI cannot do everything, though: after each app exists, two tokens have to
  be copied out of that app's web page by hand. That part is mine, and you'll walk
  me to the exact page and tell me exactly what to click.

Your job is to guide me through all of that, in order, doing every part you can do
yourself and stopping for the parts only I can do.

=== THE STEPS ===

STEP 0 — Check the machine, and settle the two questions you need answered.
  First ask me which AI assistant the app should run on: Claude Code (the default,
  and what most people should pick), Pi, or Codex. If I don't mind, choose Claude
  Code and say so. If I pick Pi or Codex, tell me plainly, in one sentence each,
  what I give up: neither can see my other apps for context, both charge my own AI
  account per message rather than running on a subscription — so the automatic
  rating stays switched off until we add one line to .env at STEP 7 — and Codex
  also can't carry the analysis over into chat or stream replies as they're
  written. Then note my answer; it decides STEP 7.
  Check: `node -v` is 22 or newer (if Node is missing, install it with
  `brew install node`; note Homebrew's Node lives in /opt/homebrew/bin and may not
  be on PATH in every shell), `npm -v` works, and my chosen assistant is installed
  and signed in — `claude auth status` reports loggedIn true for Claude Code, or
  `pi --version` / `codex --version` answers for the other two, which then need
  `pi /login` or `codex login`. Tell me if any of these need fixing and fix what
  you can.
  Also ask me now: one Slack workspace or two? And warn me that if my workspace
  requires admin approval for new apps, we will hit a wall at step 5 — ask whether
  I already know.

STEP 1 — Install the Slack command-line tool.
  Run: curl -fsSL https://downloads.slack-edge.com/slack-cli/install.sh | bash
  It installs to ~/.slack/bin and symlinks ~/.local/bin/slack, which is often NOT
  on PATH. Check whether `slack version` works; if it doesn't, either use the full
  path ~/.local/bin/slack for everything, or add it to PATH — and if you edit my
  shell profile to do that, tell me which file you changed and what you added.
  Verify with `slack version` before moving on.

STEP 2 — Connect the Slack CLI to my first workspace. THIS IS A HUMAN STEP.
  a. Run: slack auth login --no-prompt
     It prints a slash command that looks like /slackauthticket <long-string>.
  b. Show me that slash command exactly, and tell me: paste it into any channel or
     DM and press enter. The workspace matters — whichever workspace I paste it in
     is the one that gets connected, so tell me to check I'm in the right one first.
     Then I approve the permissions box that pops up, and Slack shows me a short
     "challenge code".
  c. STOP. WAIT for me to give you the challenge code.
  d. Then run: slack auth login --challenge <code> --ticket <ticket>
     using the ticket from step (a) — the ticket is the part after
     /slackauthticket.
  e. Verify with `slack auth list`. It should now show the workspace name and its
     Team ID (starts with T). Write the Team ID down — we need it at step 5.

STEP 3 — Repeat step 2 for the second workspace, if I said I have two.
  Same dance, but I must paste the slash command in the OTHER workspace. Afterwards
  `slack auth list` should show both, each with its own Team ID.

STEP 4 — Get the project ready.
  In the repo folder run `npm install`.
  Look at .slack/apps.json. If it lists apps belonging to whoever built this repo
  (team IDs that aren't mine), clear them out — leave the file as
  {"apps": {}} — so the CLI doesn't try to act on apps I have no access to. Show me
  what you're about to change first.
  The repo already contains a .slack folder, so `slack project init` is usually
  unnecessary — only run it if a slack command later complains that this isn't a
  Slack project. (If you do run it: it needs npm on PATH, and fails with
  "command not found: npm" if npm isn't there.)
  Then check the app description Slack will read: `slack manifest validate`
  — it should print "App Manifest Validation Result: Valid". If it asks you to
  pick an app, re-run it with the --app flag it suggests; if the apps it offers
  aren't mine, that's the stale apps.json above. It's also fine to leave this check
  until after step 5, when I have an app of my own.

STEP 5 — Create and install the Slack app, once per workspace.
  Run, for each Team ID from step 2/3:
      slack app install --team <TEAM_ID> --environment deployed
  This creates a Slack app from manifest.json in this repo and installs it in that
  workspace. It prints an App ID (starts with A). Note it down — one App ID per
  workspace. `slack app list` shows them again later.

  IF MY WORKSPACE REQUIRES ADMIN APPROVAL: Slack will offer "Request to Install"
  rather than installing. Don't try to work around it and don't try another route
  — there isn't one. Tell me plainly what happened, help me submit the request with
  a one-line justification ("a personal tool that shows me my own DMs and mentions,
  reading only what I can already see"), and tell me setup for THAT workspace is
  paused until an admin approves. If I have a second workspace that did work, carry
  on with that one and we'll come back.

  Do NOT suggest creating the app by pasting the manifest into the api.slack.com
  web form. It's an easy way to get a "Something went wrong" error with no
  explanation, and the CLI path works.

STEP 6 — The two tokens, per workspace. THIS IS A HUMAN STEP.
  The CLI cannot print these; only I can copy them out of the web page. For each
  App ID, give me the exact URL and the exact clicks, one workspace at a time, and
  explain in one sentence what each token is for:

  Token 1 — the user token (starts with xoxp-). This is what lets the app read my
  DMs and mentions and post my replies, seeing exactly what I can see and nothing
  more. (It's a *user* token, not a bot token, deliberately — a bot would only see
  channels it had been invited to.)
      Go to https://api.slack.com/apps/<APP_ID>
      Left sidebar → "OAuth & Permissions"
      Copy the value under "User OAuth Token" (starts with xoxp-)

  Token 2 — the app-level token (starts with xapp-). This opens the always-on
  connection Slack pushes new messages down, so the app needs no public web
  address.
      Same page → left sidebar → "Basic Information"
      Scroll to "App-Level Tokens" → "Generate Token and Scopes"
      Give it any name, add the scope "connections:write", click Generate
      Copy the token (starts with xapp-) — Slack may only show it once

  STOP and WAIT while I do this. Do NOT ask me to paste either token to you.

STEP 7 — The .env file.
  Run `cp .env.example .env`, then TELL ME to open .env and paste in the values
  myself (`open -e .env` is fine). The keys are:
      SLACK_A_USER_TOKEN=xoxp-...
      SLACK_A_APP_TOKEN=xapp-...
      SLACK_B_USER_TOKEN=xoxp-...
      SLACK_B_APP_TOKEN=xapp-...
  Workspace A and workspace B are just slots — if I have one workspace, fill A and
  delete or leave blank the B lines. The comments at the top of .env.example name
  the original author's workspaces; have me replace them with mine.

  Then, if I picked something other than Claude Code at STEP 0, add the assistant
  setting to the same file. These are not secrets, so YOU add them, not me:
      COPILOT_HARNESS=pi          (or codex — leave the line out for Claude Code)
      COPILOT_HARNESS_SPEND_OK=1  (only if I say yes — see below)
  Pi and Codex bill my own AI account for every message they read, so the app
  deliberately leaves automatic rating switched OFF for them until that second line
  exists. Explain that, ask me whether to switch it on, and respect my answer —
  without it the app still runs, still collects my messages, and I can still chat
  about any of them; it just won't rate them on its own.

  Then run `chmod 600 .env` (so only I can read it) and confirm git ignores it with
  `git check-ignore .env`.
  You may verify ONLY that each line's value starts with xoxp- or xapp- and is long
  — for example by checking prefixes and lengths without printing the values. If a
  token is wrong, say which line is wrong, not what it contains.

STEP 8 — Run it.
  First check nothing else is already running it: if http://127.0.0.1:5252 already
  answers, a copy is running and you must NOT start a second one — two copies
  against the same database double the Slack traffic and double the AI usage.
  Otherwise run `npm run dev` and open http://127.0.0.1:5252.

STEP 9 — Check it actually works, and don't declare victory early.
  - The top right of the window shows one line per workspace: green dot = connected.
  - Send myself a DM in Slack (a DM to Slackbot works) and confirm it shows up in
    the list within a few seconds.
  - Within a few minutes, items should stop saying "Waiting to be prioritized" and
    get an urgency rating. If everything stays unrated, the app puts the reason on
    screen, in the words of whichever assistant we chose, and usually with the exact
    command that fixes it — read it out to me and do what it says rather than
    guessing. The usual cause is that assistant not being signed in.
  - Also read the terminal output for lines starting with [config], [main] or
    [harness] — they say which workspaces were accepted, which assistant is running,
    and whether it passed the app's own safety check at startup.

STEP 10 — Install it as a proper Mac app (ask me first whether I want this).
  Run `npm run app:build`, then tell me to double-click install.command in the
  project folder. Warn me about the first-launch warning macOS shows for apps it
  hasn't seen before ("unidentified developer") and the fix: Applications folder →
  Control-click "Slack Copilot" → Open → Open. Note the project folder must stay
  where it is — the app reads .env and the database from it.

FINALLY
  Give me a five-line summary: what's running, where the window lives, that the
  menu bar icon is the way back in, and the two or three keys that matter (j/k to
  move, enter to open, e to file it away). Then point me at the "Using it, day to
  day" section of README.md.
````

**This prompt is written for [Claude Code](https://claude.com/claude-code)**, where
the agent already has your terminal and your files. It works in other coding agents
too, but you may have to grant filesystem and terminal access first, and some
agents will need you to run the commands yourself and paste back the output — in
that case tell it so at the start, and it will adapt.

### Using a different AI agent

Slack Copilot runs on **Claude Code** unless you tell it otherwise. To use something
else, add one line to the `.env` file in the project folder:

```
COPILOT_HARNESS=pi
```

The values it accepts are `claude-code` (the default), `pi` and `codex`. Leave the
line out and nothing changes.

They are not the same, and the differences are worth a minute before you switch:

| | Claude Code (default) | Pi | Codex |
|---|---|---|---|
| **Signing in** | `claude auth login` | `pi /login` | `codex login` |
| **What it costs** | Your existing Claude subscription's allowance | Your own AI account, charged per message it reads | Your own OpenAI account, charged per message it reads |
| **Rates your messages on its own** | Yes | Only once you add `COPILOT_HARNESS_SPEND_OK=1` to `.env` | Only once you add `COPILOT_HARNESS_SPEND_OK=1` to `.env` |
| **Context from your other apps** | Yes — it can read (never change) the tools you have already connected to Claude Code, like a calendar or a task list | No, none | No, none |
| **Chat picks up where the rating left off** | Yes — it starts from the thinking behind the rating | Yes | No — each chat starts from the conversation and the app's summary of it |
| **Replies appear** | Word by word as they're written | Word by word | All at once, when they're ready |
| **Installing it** | [claude.com/claude-code](https://claude.com/claude-code) | `npm install -g --ignore-scripts @earendil-works/pi-coding-agent` | `npm install -g @openai/codex` |

The row that surprises people is the third one. Pi and Codex bill your own AI account
for every message they read, so the app will not run that in the background until you
say so in writing. Everything else still works meanwhile — messages still arrive, the
list still works, and you can still open a chat about any conversation.

**One thing the app does for you whichever you pick:** before any of your messages are
sent to an assistant, it checks for itself that the assistant can't write files or
reach out to the network — and one that can't demonstrate that is used with no tools
at all.

**If the assistant you named isn't there**, the app still starts. Slack still comes in,
the list still works, and you can still send replies — what stops is the rating, and
the app tells you so on screen in that assistant's own words, with its own command to
fix it. A Codex user is never told to sign in to Claude. A value the app doesn't
recognise is treated as a typo rather than guessed at: it refuses to start and prints
the ones it knows, rather than quietly falling back to Claude Code and running up an
account you didn't mean to use.

---

## What you need before you start

The agent above checks all of this with you and installs what's missing — this
table is here so you can see what you're getting into, and for anyone setting up
by hand.

**Read the last item first — it is the only thing that can stop you dead.**

| | |
|---|---|
| **A Mac** | Apple Silicon (M1 or later). The packaged app is built for `mac-arm64` only. |
| **Node 22 or newer** | `brew install node`. Homebrew puts it in `/opt/homebrew/bin`, which is not always on the PATH of a non-login shell — if `node -v` says "command not found" in some window, that is why. |
| **An AI assistant, signed in** | **Claude Code** unless you choose otherwise: install it, then run `claude auth login` (`claude auth status` should say `"loggedIn": true`). Slack Copilot runs it through *your* own login — there is no API key anywhere in this project, and you are never asked for one. Expect it to use your Claude plan's allowance: every conversation gets read, and if you hit a usage limit the app says so and resumes when it resets. Pi and Codex work too, with real trade-offs — see [Using a different AI agent](#using-a-different-ai-agent). |
| **One or two Slack workspaces** | The app has two slots, **A** and **B**. Fill in one if you only have one workspace, both if you have two. There is no slot C. |
| **Permission to install an app in those workspaces** | ⚠️ **This is the blocker.** Many companies require an admin to approve every new Slack app. If yours does, the install step will offer you a **"Request to Install"** button instead of installing, and nothing works until a Slack admin approves it. Find out now, before you do the rest of the work: ask your Slack admin, or look at **Settings & administration → Manage apps** in Slack and see whether it says app approval is required. |

Setup takes about 20 minutes if nobody has to approve anything.

---

## Set it up by hand

Everything the prompt does, written out. Follow it top to bottom.

### 1. Prerequisites

```bash
node -v                # must be 22 or newer — brew install node
npm -v
claude auth status     # should include "loggedIn": true — else: claude auth login
```

Homebrew's Node lives in `/opt/homebrew/bin`. If a shell can't find `node`, put
that directory on your PATH.

That third line is for Claude Code, which is what the app uses unless you say
otherwise. If you would rather run it on Pi or Codex, check that one instead
(`pi --version` then `pi /login`, or `codex --version` then `codex login`) and read
[Using a different AI agent](#using-a-different-ai-agent) before step 7.

### 2. Install the Slack CLI

```bash
curl -fsSL https://downloads.slack-edge.com/slack-cli/install.sh | bash
slack version          # "Using slack v4.x.x"
```

It installs into `~/.slack/bin` and drops a symlink at `~/.local/bin/slack`. That
directory is frequently **not** on your PATH, so `slack` may appear to be missing
even though it installed fine. Either use `~/.local/bin/slack` everywhere, or add
this to `~/.zshrc`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### 3. Connect the Slack CLI to each workspace

This is the fiddliest part. Do it once per workspace.

```bash
slack auth login --no-prompt
```

It prints a slash command like `/slackauthticket ISQWLiZT0OtMLO3YWNTJO0...`.

1. Copy that whole slash command.
2. In Slack — **in the workspace you want to connect** — paste it into any channel
   or DM and press enter.
3. Approve the permissions box that appears.
4. Slack shows you a short **challenge code**.

Then finish the login with that code and the ticket (the long string after
`/slackauthticket`):

```bash
slack auth login --challenge <code> --ticket <ticket>
```

Repeat for your second workspace, pasting the slash command in *that* workspace.
Check what you've got:

```bash
slack auth list
```

```
your-workspace (Team ID: T01234567)
User ID: U01234567
Last Updated: ...
Authorization Level: Workspace
```

**Write down the Team ID** (starts with `T`) for each workspace — the next step
needs it.

### 4. Get the project ready

```bash
git clone <this repo>
cd slack-copilot
npm install
```

**Check `.slack/apps.json` first.** It is committed to the repo, so a fresh clone
may still list the apps of whoever built it. Those entries are keyed by Team ID, so
they won't collide with yours — but the CLI will offer them to you in prompts and
then fail, because you have no access to them. Empty it out before you start:

```json
{ "apps": {} }
```

The repo already ships a `.slack/` folder, so you do **not** normally need
`slack project init`. Run it only if a `slack` command complains that this isn't a
Slack project — and note that it wants to run `npm install` itself, so it fails
with `command not found: npm` if npm isn't on the PATH of that shell.

Once you have an app of your own (step 5), this should print
`App Manifest Validation Result: Valid`:

```bash
slack manifest validate
```

If it asks you to pick an app, re-run it with the `--app A...` value it prints.

### 5. Create and install the Slack app, once per workspace

```bash
slack app install --team <TEAM_ID> --environment deployed
```

This creates a Slack app from this repo's `manifest.json` and installs it into that
workspace. It prints an **App ID** starting with `A`. Run it again with the other
Team ID for your second workspace — the same manifest, two separate apps.

```bash
slack app list                 # App ID + Team ID + Status for each workspace
```

> **If your workspace requires admin approval**, you'll be offered
> *"Request to Install"* instead of an install. There is no way around that; submit
> the request and wait for an admin. Everything else can wait too — the tokens in
> step 6 don't exist until the app is installed.

> **Don't create the app by pasting `manifest.json` into the web form at
> api.slack.com.** The web validator rejects a manifest that has a
> `background_color` without a `long_description` of 175+ characters, and reports it
> only as *"Something went wrong"*. This repo's manifest has neither field, so the
> CLI path is clean — but it's a trap if you start editing the manifest.

### 6. Copy the two tokens out of the web UI

The CLI will not print these. Go to `https://api.slack.com/apps/<APP_ID>` (or run
`slack app settings --app <APP_ID>` to open it), once per app:

| Token | Where | What it's for |
|---|---|---|
| **User token**, `xoxp-…` | **OAuth & Permissions** → *User OAuth Token* | Lets the app read your DMs and mentions and post your replies. It's a **user** token, not a bot token — a bot only sees channels it's been invited to, a user token sees exactly what you see. |
| **App-level token**, `xapp-…` | **Basic Information** → *App-Level Tokens* → **Generate Token and Scopes**, add the scope **`connections:write`** | Opens the always-on socket Slack pushes new messages down, so the app needs no public web address. This one can't come from the manifest — you have to generate it. |

Slack may show the `xapp-` token only once. Copy it before you close the box.

### 7. Fill in `.env`

```bash
cp .env.example .env
open -e .env      # paste the four values
chmod 600 .env    # it holds a token that can act as you in Slack
git check-ignore .env    # should print ".env"
```

```
SLACK_A_USER_TOKEN=xoxp-...
SLACK_A_APP_TOKEN=xapp-...
SLACK_B_USER_TOKEN=xoxp-...
SLACK_B_APP_TOKEN=xapp-...
```

`A` and `B` are just slots — the comments in `.env.example` name the original
author's workspaces, so replace them with yours. A workspace is only switched on if
**both** of its tokens are present and start with the right prefix; anything else is
skipped with a warning on startup (`src/config.ts`). One workspace is fine: fill
`A`, leave `B` empty.

Two optional lines belong in the same file if you are not using the default
assistant — see [Using a different AI agent](#using-a-different-ai-agent):

```
COPILOT_HARNESS=pi            # claude-code (default) | pi | codex
COPILOT_HARNESS_SPEND_OK=1    # only for pi/codex: yes, rate my messages automatically
```

### 8. Run it

```bash
npm run dev        # then open http://127.0.0.1:5252
```

⚠️ **Never run two copies against the same database.** Two servers ingest and
analyze the same threads — double the Slack API calls, double the Claude usage. If
something already answers on `127.0.0.1:5252`, that's a copy already running. (The
Mac app knows this: if it finds a server already there, it attaches to it instead of
starting its own.)

### 9. Check it works

- Top right of the window: one line per workspace, green dot = connected.
- Send yourself a DM in Slack (a DM to Slackbot is easiest) — it should appear in
  the feed within seconds.
- Within a few minutes, items stop saying *"Waiting to be prioritized"* and get an
  urgency rating. If they never do, the app tells you why on screen, along with the
  command that fixes it — most often the assistant isn't signed in (`claude auth
  login` for the default). The startup log's `[harness]` line says which assistant
  is running and whether it passed the app's own safety check.

### 10. Install the Mac app (optional but recommended)

```bash
npm run app:build
```

Then double-click **install.command** in the project folder. It copies the app into
Applications, remembers where this folder is, starts it, and sets it to start at
login. (`install.command` will also build for you if you skip `npm run app:build`.)

Keep the project folder where it is — the app reads `.env` and the database from it.

**The first time you open it, macOS may warn you.** Because the app is built locally
rather than bought from the App Store, you may see:

> **"Slack Copilot" cannot be opened because it is from an unidentified developer.**

That's expected. Once, and only once:

1. Dismiss the box.
2. Open **Applications** (Finder → Go → Applications).
3. Hold **Control** and click **Slack Copilot**.
4. Choose **Open**, then **Open** again in the box that appears.

If instead you see **Open System Settings**, click it, scroll to *"Slack Copilot"
was blocked*, and click **Open Anyway**.

---

## Using it, day to day

**The speech bubble at the top of your screen is the way in.**

| What you see | What it means |
|---|---|
| A filled speech bubble | Everything is working. |
| A bubble with a number next to it, like `3` | 3 urgent messages are waiting for you. |
| A hollow bubble | It is still starting up. Give it a few seconds. |
| A crossed-out bubble with a `!` | Something is wrong. Click the bubble and read the first line of the menu. |

**Click the bubble** — with either mouse button — and a short menu appears:

- **Open Slack Copilot** is the first item, so opening the window is one more click.
- Underneath it, in plain words: how things are going, and how many urgent
  messages are waiting.
- Below that: close the app, restart it, stop it starting automatically, or find
  the files to send someone if you need help.

**Closing the window does not switch it off.** It keeps watching in the
background — that is the point. To switch it off completely, click the bubble
and choose **Quit Slack Copilot**.

### The list

Three tabs across the top — **Inbox**, **Done**, **All** — and a **Sort** control:

- **Priority** (the default): most urgent first, newest first within each level.
  Conversations Claude hasn't rated yet stay pinned at the top.
- **Newest** / **Oldest**: one flat list by time, ignoring urgency.

Each row shows the urgency, which workspace and channel it came from, who wrote
last and what they said, and — the line your eye actually reads — Claude's one-line
reason it matters.

### Keyboard

You can run the whole thing without the mouse. Press `?` for the full list.

| Key | What it does |
|---|---|
| `j` / `k` (or `↓` `↑`) | Move down / up. Previews as you go; doesn't change anything. |
| `enter` (or `o`) | Open it: marks it seen, moves you into the conversation. |
| `e` | File it away as done, and move to the next one. |
| `u` | Put it back to unseen. |
| `c` | Open the chat with Claude about this conversation. |
| `s` | Open it in Slack. |
| `esc` | Back out one level: chat → conversation → list. |
| `1` `2` `3` | Inbox / Done / All. |
| `shift + S` | Cycle the sort order. |
| `?` | Show all the shortcuts. |

### Talking to Claude, and sending a reply

Press `c` on any conversation and a chat panel opens on the right. Claude already
knows that thread — it has read it and formed a view — so you can start with
"what's the fastest way out of this?" or "draft something polite that says no".
(If you switched the app to Codex, each chat instead starts from the conversation
and the rating it was given, rather than the thinking behind it.)

When Claude proposes a reply, it appears as a **draft in an editable box**. Nothing
is sent until you press the send button, which is labelled with where it's going.
You can edit the draft first, and what gets posted to Slack is exactly the text in
that box at the moment you click. Claude has no ability to send anything by itself —
that isn't a setting, it's how the app is built.

### Notifications

When a genuinely urgent message arrives, your Mac shows a notification in the
corner of the screen. Click it and Slack Copilot opens straight to that message.

It is deliberately quiet:

- Only the most urgent messages ever cause a notification. Routine ones never do.
- The same conversation never notifies you twice.
- Messages from before it started watching never notify you at all, so installing
  it — or leaving it off for a week — cannot set off a pile of notifications about
  things you have already read.
- Every conversation that already existed the first time it ran is adopted in
  silence, even if Claude only decides later that one of them was urgent.

If you are not seeing notifications, open the Slack Copilot window, then from the
menu at the very top of the screen choose **Slack Copilot → Send a test
notification**. If nothing appears, macOS is blocking them: open System Settings →
Notifications → Slack Copilot and switch **Allow notifications** on.

### What "unread" means here, and the first day

The blue dot means **arrived since Slack Copilot has been watching your Slack** —
not "unread in Slack".

The first time it runs it collects the last couple of days of messages so nothing is
missing, and it also does this whenever it has been switched off for a while. It
knows the difference between the two:

- Messages from **before it started watching** are filed as already read. They are
  all there, and you can read them, but they do not get a blue dot, they are not
  counted next to the menu bar icon, and they never cause a notification. So the
  first time you open it, you do not get a screenful of things you dealt with in
  Slack last Tuesday.
- Messages that arrive **while it is watching** — including ones that came in
  overnight or while your laptop was shut — are unread, exactly as you would
  expect.

### If someone edits or deletes a message

Slack Copilot follows along. If someone changes what they wrote, the wording here
changes too, and Claude reads it again and updates its summary. If someone deletes
a message, it stops showing what it said. Neither of these puts a conversation you
have already dealt with back in your list.

### Closing your laptop, restarts, and crashes

- **Closing the lid** is fine. It pauses, and picks up where it left off when you
  open the lid again.
- **Restarting your Mac** is fine. It comes back by itself when you log in.
- **If the background part stops for any reason**, it restarts itself within a
  few seconds. If it keeps failing, the menu bubble changes to the crossed-out
  version so you can see it, instead of it just going quiet.

---

## How it works

One Node process and an Electron shell around it. Slack pushes new messages down a
Socket Mode connection (so there's no public URL or tunnel anywhere); a catch-up
sweep asks Slack for anything missed while your laptop was shut, because Socket Mode
never replays; everything is filtered down to your DMs and your mentions and stored
in a local SQLite file; a serial worker hands each conversation to the AI assistant
you chose — read-only, with no tools that can change anything, which the app proves
to itself before sending anything — and writes back an urgency, a reason, a summary
and a suggested action; a small Express server bound to `127.0.0.1` serves the UI and
the chat stream.

The full architecture, including why each of those choices was made and the security
model, is in **[DESIGN.md](DESIGN.md)**.

---

## Privacy

Everything stays on your Mac.

- **Your Slack tokens** live in `.env` in the project folder, and are sent to
  nothing but Slack itself. They are never logged, never printed, and never given to
  Claude — the analyzer's subprocess has every `SLACK_*` variable stripped out of its
  environment before it starts.
- **Your messages** live in `data.db`, a SQLite file in the same folder. Both `.env`
  and `data.db` are gitignored, so neither can be committed by accident.
- **The AI runs through your own login on this Mac** — Claude Code by default, or Pi
  or Codex if you chose one of those. There is no API key in this project, nothing is
  billed to anyone else, and no account beyond your own is involved. Your messages go
  to it only as part of reading your own threads, exactly as they would if you pasted
  the conversation in yourself.
- **Nothing is ever posted to Slack without a click.** The send path is a plain
  endpoint that posts the bytes in its request body — the text you just looked at.
  The assistant's sessions run with no tools that could reach it, and before your
  messages are sent anywhere the app checks for itself that the assistant it is about
  to use cannot write files or reach the network; one that can't show that is given no
  tools at all.
- **The window is served from your own Mac.** The server binds to `127.0.0.1` only,
  rejects requests with any other `Host`, and requires a token minted fresh each run.
  Nothing about it is on the internet and nobody else can open it.
- **Logs never contain message text, draft text or tokens** — they're written to be
  safe to send to someone when you need help (Library → Logs → Slack Copilot).

---

## Known limitations

- **The first import goes back 2 days**, on purpose — enough that nothing recent is
  missing, little enough that opening it the first time isn't a wall of history.
- **A catch-up sweep looks back at most 30 days.** If you leave it off for longer,
  the gap in between is simply not imported.
- **No reactions.** Emoji reactions aren't captured, shown, or sendable.
- **Slack's message search isn't available to these tokens** (`search:read` is
  deliberately not requested), so mentions are found by walking your channels
  instead. That's bounded — 40 channels, 3 pages each per sweep — so a mention in a
  channel you're barely in can be missed.
- **The Mac app is unsigned and not notarised**, hence the one-time
  "unidentified developer" dialog.
- **macOS on Apple Silicon only.** The server itself is just Node, but the packaged
  app is built `mac-arm64`, and the menubar, notifications and login-item behaviour
  are all macOS.
- **One person, two workspaces, no settings screen.** There's no multi-user mode, no
  auth beyond the localhost token, no search over your history, and no auto-send of
  anything, ever.

---

## When something looks wrong

Slack Copilot tells you rather than failing quietly. Click the speech bubble and
read the first line of the menu.

| It says | What is happening | What to do |
|---|---|---|
| Connected to *(your workspaces)* | All good. | Nothing. |
| Starting up… | It is waking up. | Wait a few seconds. |
| Disconnected from Slack — retrying | Slack or your internet dropped. | It reconnects on its own. If it stays like this, check your internet. |
| Not running — retrying… | The background part stopped and is being restarted. | Wait. If it does not clear, choose **Restart Slack Copilot**. |
| Slack is not set up yet | Your Slack sign-in details are missing. | Check `.env` has all four values and none of them still say `...`. |
| Can't sign in to Slack | Your Slack sign-in details have expired or been revoked. | Redo steps 6–7 of the manual setup for that workspace: fresh tokens, into `.env`. |
| Something else is using the connection this app needs | Another program has taken the door it uses. | Restart your Mac. |
| Slack Copilot can't find its files | The Slack Copilot folder was moved or renamed. | Open the folder and double-click **install.command** again. |

Inside the Slack Copilot window, the top right corner shows one line per Slack
workspace with a coloured dot: green when it is connected, amber while it is
reconnecting, red when it cannot get in. Hover over a line to read why. If Slack
drops out, that dot changes — the app does not just go quiet on you.

If you need to send someone the details, click the bubble and choose **Show the
activity log** — a Finder window opens with the files they will ask for.

### Setup problems

| Symptom | Cause and fix |
|---|---|
| `slack: command not found` | `~/.local/bin` isn't on your PATH. Use `~/.local/bin/slack`, or add `export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc`. |
| `node: command not found` in some windows | Homebrew's Node is in `/opt/homebrew/bin`, which non-login shells often don't have. Add it to PATH. |
| `slack project init` fails with `command not found: npm` | Same problem, for npm. Run it from a shell where `npm -v` works. |
| Slack offers **"Request to Install"** instead of installing | Your workspace requires admin approval. Nothing to debug — submit the request and wait. |
| Pasting `manifest.json` into api.slack.com gives *"Something went wrong"* | The web form rejects `background_color` without a 175+ character `long_description`. Use `slack app install` instead, and don't add those fields. |
| `slack manifest validate` asks you to pick an app | You have more than one app in the project. Re-run with the `--app A...` value it suggests. |
| Startup says *"workspace A: tokens present but incomplete or placeholder"* | One of that workspace's two tokens is missing, still `xoxp-...`, or has the wrong prefix. Both must be there for the workspace to switch on. |
| Everything sits at **"Waiting to be prioritized"** | The assistant isn't reachable. The app names the reason on screen and offers that assistant's own fix — usually its sign-in command (`claude auth login` for the default). It also happens when a usage limit has been hit, and then it resumes on its own. |
| The app says your assistant **is not installed on this Mac** | Whatever `COPILOT_HARNESS` names in `.env` isn't on this machine. Install it — the message carries the exact command — or delete that line to go back to Claude Code. Messages keep arriving and replies keep sending meanwhile; only the rating stops. |
| The app says it **could not prove it runs safely on this Mac** | The check the app runs before sharing anything — that the assistant can't write files or reach the network — didn't pass, so nothing is being sent to it. Update that assistant, or switch back to Claude Code in `.env`. This is a deliberate stop, not a crash. |
| It **won't start at all**, saying *"COPILOT_HARNESS=… is not a harness this app knows"* | A typo in `.env`. The values it accepts are printed with the message: `claude-code`, `codex`, `pi`. It refuses rather than guessing, because guessing would quietly use an account you didn't choose. |
| Nothing is being rated and the app mentions **`COPILOT_HARNESS_SPEND_OK`** | Pi and Codex charge your own AI account for every message they read, so automatic rating stays off until you add `COPILOT_HARNESS_SPEND_OK=1` to `.env` and restart. Chat still works without it. |
| Feed stays empty and both dots are red | Tokens are wrong or the app was uninstalled from the workspace. Check `slack app list` shows *Installed*. |
| Nothing appears, and you have two copies running | Only run one. Check `127.0.0.1:5252` before starting anything, and quit the Mac app first if you want `npm run dev` to own the port. |
| A `slack` command offers you apps you've never seen, or fails with an auth error on one | `.slack/apps.json` is committed, so a fresh clone inherits the previous owner's apps. Reduce it to `{ "apps": {} }`; your own `slack app install` refills it. |

---

## Removing it

Double-click **uninstall.command** in the Slack Copilot folder, type `remove`
when it asks, and press Return.

That removes the app and stops it starting automatically. It does **not** delete
the Slack Copilot folder, your Slack sign-in details, or the messages it has
already collected — so you can put it back later by running **install.command**
again.

To detach it from Slack as well, uninstall the app from each workspace
(`slack app uninstall --team <TEAM_ID>`) or delete it outright
(`slack app delete --team <TEAM_ID>`), and then delete `.env` and `data.db`.

---

<details>
<summary><b>Technical notes</b></summary>

### Commands

```bash
npm run dev          # tsx watch src/index.ts — serves http://127.0.0.1:5252
npm start            # same, no watch
npm run typecheck    # tsc --noEmit (no build step; tsx runs the TypeScript directly)
npm run app:build    # builds release/mac-arm64/Slack Copilot.app (ad-hoc signed)
npm run app:dev      # runs the Electron shell from source, without packaging
npm run app:icons    # regenerates assets/ from code (no binary assets in git)
npm run harness:probe   # checks each AI assistant's read-only claim on this Mac
```

Useful env switches: `PORT`, `COPILOT_DB_PATH` (throwaway database),
`ANALYZER_DISABLED=1`, `COPILOT_REPLY_DRYRUN=1` (exercise the send path without
messaging anyone).

The AI assistant is chosen with `COPILOT_HARNESS` (`claude-code` | `pi` | `codex`,
default `claude-code`); `COPILOT_HARNESS_COMMAND` points at a specific binary,
`COPILOT_HARNESS_MODEL` picks the model, and `COPILOT_HARNESS_SPEND_OK=1` lets an
assistant that bills per token run the background rating. `npm run harness:probe`
prints each one's tool posture, whether it is installed, and the result of its
read-only proof; `--live` additionally spends one real run per assistant on a
prompt that tries to write a file, reach a local canary and obey an injected
instruction. The design behind all of it is `docs/harness-providers.md`.

`CLAUDE.md` is the working guide for agents changing this code; `DESIGN.md` is the
architecture; `docs/ux.md` is the UI spec.

### What the Mac app actually is

An Electron shell around the existing server. It does **not** re-implement or
import anything from `src/` — it spawns the project's own entry point as a child
process:

```
node --import tsx <projectDir>/src/index.ts --copilot-managed
```

so the packaged app always runs whatever is currently in `src/`, picks up `.env`
and `data.db` from the project directory, and can never drift from the dev setup.
`npm run dev` is unaffected and still works exactly as before.

### Behaviour worth knowing

- **The watch-start rule.** Each workspace records, once and forever, the moment it
  first connected (`sync_state`, reserved `channel_id = '__watch_start__'`). The
  catch-up sweep stores everything it finds, but a message older than that mark does
  not mark its thread unread — so a first run does not present days of already-read
  history as a queue. Live messages are unaffected. The rule and its rationale are
  documented at length in `src/db.ts`; it is applied by the `ingest` callback in
  `src/ingest.ts`. An existing database is tidied up once on startup
  (`markPreWatchThreadsSeen`, guarded by a marker row, `VACUUM INTO` backup first).
- **Menu bar.** Both mouse buttons open the same menu; `Open Slack Copilot` is the
  first item. Nothing about the app's state is reachable only by right-clicking.
- **Slack connection state** comes from `GET /api/status`, which `src/ingest.ts`
  feeds from the Socket-Mode lifecycle events. The app reads it on each feed poll,
  which is why the menu can say `Connected to <teams>` even when it attached to a
  server it did not start (and therefore cannot read that server's log).
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
  shell's `PATH` for the child so the analyzer can find the `claude` command — or
  `pi` or `codex`, if that is what `COPILOT_HARNESS` names.
- **Signing.** The bundle is ad-hoc signed (`codesign --sign -`). It is not
  notarised, hence the first-open dialog documented above.
- **Login item.** `app.setLoginItemSettings({ openAtLogin: true })` on first run,
  re-applied automatically after a reinstall (replacing the bundle drops the
  registration), but not overridden if it was turned off deliberately.

### Files

```
src/               the server: config, db, ingest, backfill, analyzer, chat, health
src/harness/       the AI-assistant layer: the contract, the registry, one file per assistant
public/            the web UI (one vanilla HTML file + the chat pane)
electron/          the Mac app (main process, waiting screen, builder config)
scripts/           icon generation and the build
assets/            generated icons — safe to delete, regenerated by the build
manifest.json      the Slack app definition, installed by `slack app install`
install.command    double-click installer
uninstall.command  double-click uninstaller
```

Build output lives in `release/` and `electron/assets/` +
`electron/project-path.json`; all are generated and git-ignored, as are `.env` and
`data.db*`.

</details>

## License

MIT — see [LICENSE](LICENSE). Do what you like with it; just don't blame us if your inbox talks back.
