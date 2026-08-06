# Making the screen quieter — three options

Companion to `docs/ux.md`. This is a **proposal**, not a change. Nothing in `public/` has been touched.
Side-by-side pictures: **`docs/ux-declutter-mock.html`** — open it in a browser, it has a Light/Dark switch built in.

---

## How I looked

I opened the app you are actually running (16 real threads, 15 of them with Claude's analysis on them) at two window
sizes: a big monitor (1480 × 900) and a 13-inch laptop (1440 × 745). Then I measured every strip, every button row,
and — this turned out to be the important one — how much of each line of text is actually visible before it gets cut
off with a "…".

---

## What's actually crowding the screen

Ranked by how much it costs you, not by how big it is. **I disagree with where the list started.** The two strips
at the bottom are real, but they're 4th and 5th, not 1st. The expensive problem is inside the cards.

### 1. Claude's one line is cut in half on every single card

This is the line the whole product is for, and it is the line you never get to finish reading.

| | |
|---|---|
| How much of it you can see | **50%–74%**, average **61%** |
| Cards where it is cut | **15 of 15** |

And it's cut in the worst possible place, because the verdict is at the **end** of the sentence:

| What you see on the card | What's hidden after the "…" |
|---|---|
| "Automated Ramp reminder to review 7 routine expens…" | "…transactions; **no deadline or blocker**" |
| "Expense reconciliation question aimed at another tea…" | "…mate; no deadline, **nobody blocked on the user**" |
| "Bio page is live; user already approved copy and sent…" | "…photo — **nothing left to do**" |
| "Automated Asana bot notifications; assigned tasks wit…" | "…h past-due dates but **no human waiting on a reply**" |

Every one of those hidden endings is the answer to "do I need to care?". The card shows you the setup and hides
the punchline. Fix this and the app gets noticeably calmer without moving a single pixel of furniture.

### 2. Fifteen of your sixteen threads say "nothing for you" — in exactly the same voice as the one that doesn't

Right now: **1 × P1, 6 × P2, 9 × P3, 0 × P0.** Reading the full sentences, thirteen of them literally end in some
version of "no deadline", "nobody blocked on you", "no action needed", "closed loop", "nothing left to do".

Every one of those gets the same 77-pixel card, the same three lines, the same coloured edge, the same bold sender
name as the P1 where someone is actually waiting on you. The one thing you opened the app for is **one sixteenth of
the ink on screen.** That is the clutter. Not the strips.

### 3. The message-preview line (row 2) is frequently invisible

Same measurement, the middle line of each card:

- 6 of 15 cards show **less than a quarter** of it.
- The worst three show **3%, 5% and 6%** — literally three or four words of a sentence, then "…".
- Two of those three are bot messages that begin with a URL, so what you see is `:inbox_tray: https://app.asana.com/app/asana…`.

That line is taking a third of every card and, most of the time, delivering a smear.

### 4. The first line of every card repeats itself

Of the six things in row 1, three carry no information most of the time:

- **"DM ·"** — on **15 of 16** threads. It marks the normal case instead of the exception.
- **The workspace letter** — `A` on **12 of 16**.
- **The ✦ sparkle** — on **16 of 16**. It means "this line came from Claude", which is always true.

### 5. Group chats are labelled with machine names

**8 of 16** conversations are named things like `mpdm-ruby--natalia--isha-1`. They're too long, so they get cut —
down to 50%–80%. The consequence isn't just ugliness: **two different conversations currently render as the identical
string** (`DM · mpdm-ellen--rub…`, once in AI Fund and once in deeplearning.ai). The only thing distinguishing them
on screen is a 14-pixel coloured letter.

### 6. The two permanent strips at the bottom — real, but smaller than they feel

| | Height | Share of a 745px laptop window |
|---|---|---|
| Keyboard hints (`j/k move · enter open · …`) | 26px | 3.5% |
| Colour legend (`P0 P1 P2 P3 analyzing …`) | 26px | 3.5% |

Together 52px — about **two-thirds of one card**. Worth removing, and here's the strong argument for it: **the `?`
overlay already teaches more than both strips combined.** The overlay lists 11 shortcuts; the strip lists 7 and
doesn't mention `shift+S` (change the order) or `1`/`2`/`3` (Inbox/Done/All) at all. And the legend only tells you
that the orange swatch means "P1" — which the chip already says in letters. It never told you what P1 *means*.

### 7. The Sort row, and the header underneath that repeats it

The Sort row is **39px, 5.2%** of a laptop window — bigger than either bottom strip — and it's a permanent control
for a setting you'll change a handful of times a year. Underneath it, the list header re-states the same fact:
"Newest" lit up in the row, and "Inbox · newest first" written out immediately below it.

### 8. Smaller repetitions, once you start looking

- The thread header says **DM twice** and shows the **workspace twice**: title `DM · mpdm-ruby--natalia--isha-1`,
  then underneath `DM · AI Fund · 11 messages · updated 03:37 PM`, with an `A` badge sitting next to both.
- In the analysis card, **Summary's first clause restates the headline**. In the live P1: headline says "Ruby
  assigned Isha to fix the invoice coding; Natalia is holding an email reply"; Summary opens by re-telling the same
  thing before it gets to the useful part (the actual dollar amounts and account codes). The rest of the Summary
  earns its place — the first sentence doesn't.
- "Discuss with Claude" stays in the thread header even while the chat panel is already open next to it.

### The furniture, totalled

Top bar 40 + Sort row 39 + keyboard strip 26 + legend 26 = **131px, or 17.6% of a 13-inch laptop window**, standing
between you and the first message. Deleting the three removable ones (91px) buys you **about one more card**. Worth
doing — but notice how modest that is next to items 1 and 2. Space isn't really the problem. Attention is.

---

## Three directions

Genuinely different, not three shades of one idea. Pick one.

---

### A — "Trim the frame"

> **The idea in one sentence:** leave the cards exactly as they are and delete the furniture around them.

**What goes**

- The keyboard-hints strip at the bottom of the list. Gone.
- The colour legend across the bottom of the window. Gone.
- The Sort row as its own row. The three buttons fold into the list header that's already there, which becomes
  `Inbox · most urgent first ▾` — one line doing both jobs instead of two lines doing one job twice.
- The "16 threads · updated 20:31" note moves from the legend up to the right end of that same header.

**What replaces the two strips** (this is the part that has to be right, or you've just made the app harder)

1. The `?` button in the top bar gets a word next to it — **`? keys`** — so it reads as a thing you can press rather
   than a mystery glyph.
2. The buttons already teach three of the six shortcuts by themselves: **Discuss with Claude `c`**, **Open in Slack
   `s`**, **Done `e`** all wear their key on their face. `u` is already written into the `⋯` menu as
   "Mark unseen (u)". So only `j`/`k` has nowhere to live — and the empty thread pane already says
   "Select a thread — j/k to move, enter to open".
3. The legend gets *replaced with something better rather than deleted*: hovering an urgency chip today says
   "urgency P1", which teaches nothing. Make it say what it means — **"P1 — someone is waiting on you today"** — and
   add a short "what P0–P3 mean" block to the `?` overlay. That's the thing the legend was pretending to do.

**What it costs.** A brand-new user has to press `?` once instead of reading the bottom of the screen. The colours
are no longer decoded on-screen at all times. Every problem in items 1–5 above is untouched — the cards are
identical, Claude's sentence is still cut in half.

**Who it suits.** Someone who basically likes the app and wants the noise turned down without relearning anything.

**Size: S.** Delete two blocks of HTML and their styles, move the sort buttons into the header row, rewrite a
handful of tooltips, extend the `?` overlay. All inside `public/index.html`. Reversible in five minutes.

---

### B — "Let the sentence finish"

> **The idea in one sentence:** shrink each card from three lines to two, and give the space to Claude's verdict so
> you can read all of it.

Includes A's frame trim. Then the card is rebuilt:

**What goes**

- **The message-preview line.** It's showing 3%–22% of itself on the worst cards, and Claude's sentence describes
  the thread better than four cut-off words of it ever did.
- **"DM ·"**, the ✦ sparkle, and the workspace letter on the majority workspace. Mark the exceptions
  (`#channel`, `@mention`, the other workspace), not the norm.

**What changes**

- **`mpdm-ruby--natalia--isha-1` becomes "Ruby, Natalia & you".** Worth knowing: the slug already contains the names
  — split it on `--`, drop the `mpdm-` and the trailing `-1`. That's a client-side fix needing no server change. It
  gives you handles (`ruby`, `natalia`) rather than full display names; upgrading to proper names later is a small
  server change, not a rewrite.
- **Claude's line gets the full width and is allowed to wrap onto a second line**, so it is never cut.

The card becomes:

```
┌────────────────────────────────────────────────┐
│▌ [P1]  Priya Raman · with Dana & you      5h   │
│▌ Dana assigned you to fix the invoice coding;  │
│▌ Priya is holding an email reply pending that  │
└────────────────────────────────────────────────┘
```

**What it costs.** You no longer see the literal words of the last message on the card. To read what somebody
actually typed you press `enter` — which you were going to do anyway for anything you intend to act on. If you
currently scan by "what did they literally say" rather than by Claude's line, this will feel like a loss for a week.
Also: the card doesn't get much shorter (about 68px vs 77px), so you won't fit many more on screen. The win is that
every card you *can* see, you can now read completely.

**Who it suits.** Someone who has decided Claude's one-liner is trustworthy and wants to act on it directly.

**Size: M.** One rendering function (`paintCard`) and one label function (`channelLabel`) in `public/index.html`,
plus the CSS for the card. No server change, no new data.

---

### C — "Needs you / Quiet"

> **The idea in one sentence:** stop giving equal billing to the fifteen threads that don't need you — put them in a
> short, calm list underneath the ones that do.

Includes A's frame trim and B's card. Then the Inbox splits in two:

```
  ANALYZING · 1                                       ← unchanged: unrated always sits on top
  ┌──────────────────────────────────────────────┐
  │ …  Sam Okafor · 2m                           │
  └──────────────────────────────────────────────┘

  NEEDS YOU · 1
  ┌──────────────────────────────────────────────┐
  │▌ [P1]  Priya Raman · with Dana & you    5h   │   ← full card, B-style
  │▌ Dana assigned you to fix the invoice coding;│
  │▌ Priya is holding an email reply pending…    │
  └──────────────────────────────────────────────┘

  QUIET · 9 — nothing waiting on you            ▾
    P2  Dana Whitfield   Ramp transactions have…  4h   ← one line each
    P2  Dana Whitfield   Saved here: Ecosystem…   7h
    P3  Eli Chen         ok! i'll report once…    4h
    …
```

**What goes**

- The colour legend becomes pointless, because the headings *are* the legend: "Needs you" and "Quiet" say in words
  what the colours were trying to say in colours.
- Twelve full-size cards' worth of visual weight. On your actual data the app would open showing **one card and a
  nine-line list**, instead of sixteen equal cards.

**Note what comes back.** The one-line quiet rows are the right home for the message preview that B threw away — down
there you're scanning for "wait, is that what I think it is?", not reading, so a cut-off preview does its job
perfectly well. And the Quiet block can be collapsed to a single line (`QUIET · 9 ▾`) once you trust it.

**Keyboard is untouched.** `j`/`k` walk the whole list, quiet rows included, as one sequence. `enter`, `e`, `u`, `c`,
`s` all behave exactly as they do now on whichever row the cursor is on. Nothing is hidden — the heading always
carries the count, and the Quiet block is open by default until you choose otherwise.

**What it costs.** This is a bet on the rating being right. If Claude calls something P2 that actually needed you
today, it's now sitting in a quieter place and is easier to skim past. That risk is real and it's the reason to
choose this deliberately rather than drift into it. Mitigations: the split point (P0/P1 above, P2/P3 below) should be
a setting you can move; the Quiet count is always visible; and anything unrated stays pinned at the top where it is
now. On a genuinely busy day with four or five P0/P1s, the top section simply grows and the screen looks like a
normal feed again — which is the correct behaviour.

**Who it suits.** Someone who opens this a few times a day to answer one question — *is anything on fire?* — and
wants the answer in under a second.

**Size: M–L.** The card work from B, plus a second row type, plus splitting the list build in `renderFeed`, plus a
collapse toggle and its remembered state. Still one file, still no server change.

---

## What I'd do

**Take C.**

The measurements say the screen isn't crowded by furniture — the furniture is 12% of the window and removing all of
it buys one extra card. The screen is crowded because **sixteen things are shouting at the same volume and fifteen of
them have nothing to say to you.** A is the only option that doesn't address that at all, and B only half-addresses
it (it makes each card readable but leaves you fifteen readable cards you didn't need). C is the one that changes
what you see when you open the app: one thing, then a quiet list.

It also gets A almost for free — the legend stops being necessary the moment the headings say "Needs you" and
"Quiet" in plain words.

**If you want something visible this week rather than this month,** ship A on its own first. It's a couple of hours,
it's reversible, and it doesn't commit you to C.

**And do this whatever you pick:** stop cutting Claude's sentence in half. Let it wrap to a second line. That one is
not a matter of taste — the app is currently hiding the conclusion of its own analysis on every card, and it costs
nine pixels of card height to fix.

---

## Keep as-is — looks busy, is load-bearing

Somebody tidying later will be tempted by these. Don't let them.

- **The urgency chip *and* the coloured left edge.** It looks like saying the same thing twice. It isn't: the edge is
  what you catch out of the corner of your eye from across the room, the chip is what you read when you look
  directly at it. Losing either one costs a different thing.
- **The workspace badge**, even though it's the same letter on 12 of 16 rows. Two conversations already render the
  identical channel label; that little coloured letter is the only thing telling them apart.
- **The blue unseen dot, and the rule that `j`/`k` never mark things seen.** The tab badge and the Mac notifications
  both count unseen P0/P1. If skimming cleared them, the badge would stop meaning anything.
- **"Open in Slack" never marking a thread done.** Handling something in Slack isn't the same as filing it here.
  Auto-filing on click would silently lose items.
- **The grey footer under the analysis** — "Claude read this 28m ago · up to the 03:37 PM message". It reads like
  fine print. It's the trust line: without it you can't tell whether the verdict you're reading is about the message
  you're looking at or about a conversation that has moved on since.
- **The key letters on the thread buttons** (`c`, `s`, `e`). After the hint strip goes, these *are* the hint strip.
- **"Draft this reply →"** on the suggested action. Shortest path from triage to a sent reply; don't bury it.
- **The stale ↻ marker and the amber "new replies since Claude last read this" banner.**
- **Errors staying ambient** — a strip or an inline banner, never a pop-up.
- **The Sort control itself.** Direction A moves it; nothing here proposes removing it. Three orders and `shift+S`
  all stay.

---

## Two notes for whoever is working next door

**For the light/dark palette work:** in light mode, P1-orange and P2-amber collapse toward the same brown once
they're dark enough to read as text on white. Worth checking side by side. It isn't fatal — the chip says "P1" and
"P2" in letters, so the colour is a helper, not the message — but the *left edge* of the card carries no letters, and
that's where the two will be genuinely hard to tell apart. Either separate the hues more in light mode, or accept
that on white the edge distinguishes "urgent-ish" from "not" rather than four distinct levels.

**Something already in the browser that nobody is using:** `/api/feed` already sends `summary` and `suggested_action`
for every thread, and the card throws both away — it only reads `why`. So a card could show "Suggested: reply
confirming you'll re-code the flagged invoices" with **no server change and no extra request**. Direction C's
"Needs you" card is the obvious place for that, if you want it.

---

## The mock

`docs/ux-declutter-mock.html` — one file, opens in any browser, nothing to install.

Four columns side by side: **Now**, **A**, **B**, **C**, with the same fake-but-realistically-shaped conversations in
each (long group-chat slugs, bot messages, the same mix of one urgent and many quiet). Buttons at the top switch
between **Auto / Light / Dark** so you can see both without touching your system settings, and there's a
"show what changed" checkbox that outlines the parts that are different from Now.

Point at the column you want.
