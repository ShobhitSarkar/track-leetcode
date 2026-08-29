# Recall — Deploy Guide (Supabase + Vercel, magic link auth)

Cloud-synced spaced repetition tracker for LeetCode. Sign in with an email link. Works on any device with the same email.

## The 6-step overview

Do these in order. Total time: ~15 min.

1. Create Supabase project
2. Run the schema SQL
3. Put your Supabase creds into `index.html`
4. Push to GitHub
5. Deploy to Vercel
6. Point Supabase's redirect URLs at your Vercel URL, sign in, install

That's it. No Google Cloud console, no OAuth app, no verification screens.

---

## 1. Create Supabase project

You said you've done this. If not: [supabase.com](https://supabase.com) → sign in with GitHub → **New project** → any name → any region near you → set a database password (save it somewhere). Wait ~2 min for provisioning.

## 2. Run the schema

- Supabase → left sidebar → **SQL Editor** → **New query**
- Open `schema.sql` from this folder, paste the whole thing in, click **Run**
- Should say "Success. No rows returned." That means it created the table, index, and RLS policies

Verify: sidebar → **Table Editor** → you should see a `problems` table with columns `id`, `user_id`, `name`, `pattern`, `url`, `solution`, `notes`, `solution_saved_at`, `history`, `next_review`, `created_at`.

**Already running an older version?** Re-run `schema.sql` the same way. It is idempotent, and
the `alter table ... add column if not exists` lines at the top add the flashcard columns
(`url`, `solution`, `notes`, `solution_saved_at`) to your existing table without touching your
data. The app shows an empty card for every problem until you fill one in.

**Discover's skip list needs a second table.** Re-run `schema.sql` after pulling the
Discover feature — it creates `skipped_suggestions` and its RLS policies. Without it the
Skip button on a suggestion will fail; the rest of the app is unaffected.

**Notes + flashcards need two more tables.** Re-run `schema.sql` after pulling the
Notes feature — it adds `notes` and `flashcards` (with RLS and indexes). Without them
the Notes tab loads empty and any card action fails silently; the existing four tabs
keep working. See the **Notes** section below for the full flow.

**After running any migration, reload PostgREST's schema cache.** Supabase's API layer
(PostgREST) keeps its own schema cache; a fresh table or column returns
`Could not find the … in the schema cache` until it reloads. The app auto-retries once
after a short delay, which clears it in almost every case, but if you keep seeing the
message: Supabase Dashboard → **Database** → **API** → **Reload schema**. Or run
`notify pgrst, 'reload schema';` in the SQL Editor. Either fires the reload immediately.

## 3. Put your Supabase creds into `index.html`

- Supabase → sidebar → **Project Settings** (gear icon at bottom) → **API**
- Copy **Project URL** and **anon public** key
- Open `index.html`, find these lines near the top of the `<script>` block:

```js
const SUPABASE_URL = 'https://YOUR_PROJECT.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY_HERE';
```

Replace both with your actual values. Both are safe to commit publicly — the anon key is designed to be exposed, and the Row Level Security policies from step 2 are what actually keep your data safe (each row is tied to your user ID; the DB refuses to return anyone else's rows).

## 4. Push to GitHub

Easiest way (no local git needed):

- [github.com/new](https://github.com/new)
- Repo name: `recall` (public or private, doesn't matter — the anon key is safe either way)
- Create repository (don't init with README, we have our own)
- On the empty repo page, click **uploading an existing file**
- Drag in all four files: `index.html`, `manifest.json`, `icon.svg`, `README.md`
- Commit

If you prefer CLI:

```bash
cd /path/to/folder
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/recall.git
git push -u origin main
```

## 5. Deploy to Vercel

- [vercel.com/new](https://vercel.com/new)
- If first time, sign in with GitHub, authorize
- Import the `recall` repo
- Framework Preset: **Other** (Vercel auto-detects it as a static site)
- Leave everything else default
- **Deploy**
- ~15 seconds later you get a URL like `https://recall-xyz.vercel.app`

Copy that URL.

## 6. Point Supabase at your Vercel URL, sign in

Supabase needs to know your Vercel URL is a legitimate place to send users after they click the magic link.

- Supabase → **Authentication** → **URL Configuration**
- **Site URL**: paste your Vercel URL (e.g. `https://recall-xyz.vercel.app`)
- **Redirect URLs**: add the same URL. Optional: also add `http://localhost:3000` and `http://localhost:5173` if you'll ever test locally
- Save

Now try it:

- Open your Vercel URL on your phone (Safari on iPhone, Chrome on Android)
- Type your email → tap **Send sign-in link**
- Open your email, tap the link — it takes you back to the app, signed in
- Add a couple of problems

Then install to home screen:

- **iPhone Safari**: Share → **Add to Home Screen**
- **Android Chrome**: menu (⋮) → **Install app**

Same login on your laptop = same queue. Sessions last weeks by default, so you'll rarely see the sign-in screen again.

---

## When something breaks

**"Sign-in link goes to the app but I'm not signed in"**
The Redirect URL isn't in Supabase's allow-list. Re-check step 6. It must match your Vercel URL exactly, including `https://`.

**"Failed to save: new row violates row-level security"**
RLS policies didn't get created. Re-run `schema.sql`.

**Email never arrives**
Supabase's free tier is capped at ~4 emails/hour and has occasional deliverability issues. Check spam. If still nothing after a few minutes, wait 5 min and try again. For production use you'd add a custom SMTP provider (Resend, Postmark) in Supabase → Project Settings → Auth → SMTP, but it's overkill for personal use.

**Magic link opens in a different browser than the one I signed in from**
This happens on iOS if you click links inside Gmail's in-app browser. It'll still work — you'll be signed in in whichever browser opens the link. Best experience: use Apple Mail or Gmail's default mail app so links open in Safari.

**Data not syncing between devices**
Signed in with the same email on both? Try sign-out + sign-in on one device.

## Customizing later

Everything's in `index.html`:
- `RATING_INTERVALS` — days per rating (currently 30/12/5/2)
- `RATING_LABELS` — rename the ratings
- `COMMON_PATTERNS` — pattern chips shown when adding
- `leetcodeUrlFor` — how a problem link is guessed from the name

The look lives in the `<style>` block in the `<head>`. Colors, radii, shadows and easing
are CSS custom properties on `:root` (light) and `:root[data-theme="dark"]` (dark), so
retheming the whole app means editing those two blocks and nothing else.

## Layout

Below 1024px the app is the phone layout: sticky header, big due count, segmented
Today / Add / All tabs, one column. At 1024px and up a left rail takes over identity,
the count and navigation, and the rest of the width goes to content.

Column counts come from `@container` queries on `.view-area`, not media queries, so the
grids measure the actual content width and stay correct whether or not the rail is
present. Review cards cap at two columns on purpose: they hold code and a rating grid, so
a third column costs more in readability than it gains. Change the breakpoints on
`.grid-review`, `.grid-rows` and `.grid-add` to taste.

## Notes

The Notes tab is a freeform notebook — any topic, not just a LeetCode problem. Write a
short note about a pattern, a system-design tradeoff, a language quirk, a behavioral
story. Then hit **Generate cards** to turn every paragraph into a flashcard that lives
on the same 30 / 12 / 5 / 2 spaced-repetition rhythm as your problems.

- The **Write** sub-tab holds the note body. Every paragraph (blank line between them)
  becomes one card when you generate. A colon or first sentence splits into
  front (the prompt) and back (the elaboration); if neither is present the card asks
  you to recall the whole passage.
- The **Cards** sub-tab lists every card for the note, generated or manually authored.
  Add one by hand (front + back), regenerate from the note body, or delete individually.
  Each card carries a `source` badge (`ai` / `heuristic` / `manual`) and its next
  review date. See **Card generation** below for what those sources mean.
- The **Quiz** sub-tab walks through the note's due cards one at a time. Face-down
  reveal, then a 1–4 rating that stamps the next interval, exactly like problem review.
- Every note has an optional **topic** (pill on the left of the header — e.g. "Sliding
  Window", "System Design", "Behavioral"). If a note was spawned from the Add view
  it also carries a **linked-problem** badge and can jump straight to that problem's
  card in the library.

The **Add** view has a new **Start a note for this** checkbox. Ticking it saves the
problem AND spawns a note pre-linked to it (title = problem name, topic = pattern,
body = the notes field). The app then drops you straight into the Notes tab with that
note selected, ready to jot the insight and generate cards from it.

### Card generation

Two paths, decided at request time:

1. **OpenAI (primary)** — the client posts the note to a Supabase Edge Function
   (`supabase/functions/generate-cards`), which forwards it to OpenAI and returns
   JSON flashcards. Each card is tagged `source: 'ai'`. See the deploy steps
   below.
2. **Heuristic (fallback)** — client-side, no network. Splits the note body on
   blank lines and each paragraph on the first colon or sentence to build a
   front / back pair. Cards are tagged `source: 'heuristic'`. This is what runs
   before you deploy the Edge Function, or any time the OpenAI request fails.

The toast that fires after generation names the path so you know which one ran
("Generated 4 cards via AI · next up in 5 days" vs "… via heuristic …"). Cards
already in the note aren't touched — Regenerate always **adds** cards, never
replaces them, so you can accumulate and prune by hand.

### Deploying the OpenAI Edge Function

The function is defined in `supabase/functions/generate-cards/`. Install the
Supabase CLI, log in, link your project, then:

```bash
# One-time setup
supabase login
supabase link --project-ref YOUR_PROJECT_REF

# Store your OpenAI key as a Function secret (never commit it)
supabase secrets set OPENAI_API_KEY=sk-...

# Optional: choose a model. Defaults to gpt-4o-mini.
supabase secrets set OPENAI_MODEL=gpt-4o-mini

# Deploy
supabase functions deploy generate-cards
```

That's it. The Supabase gateway verifies the caller's JWT before the handler
runs, so anonymous requests never reach OpenAI. The client sends the note body
and the current session's access token; the function returns
`{ cards: [{ front, back, code }] }` on success or an error envelope on
failure. Any non-2xx response makes the client fall back to the heuristic,
silently, so a broken key never breaks card generation entirely.

To iterate locally without redeploying:

```bash
supabase functions serve generate-cards --env-file supabase/functions/.env.local
```

Rough per-card cost with `gpt-4o-mini`: a typical note produces 3–8 cards for
well under a cent. Bigger models are trivial to swap via `OPENAI_MODEL`.

The rail's due-count on **Today** now also flags flashcards: if any cards are due,
a small "N flashcards due" pill sits below the problem count and jumps to Notes so
one morning session covers both queues.

## Flashcards on problems

Each problem can hold the solution you actually wrote, your notes, and a link to the
problem itself. When it comes up for review, the card stays face down behind a
**Reveal solution** button so you attempt recall first, then check yourself, then rate.

- Fill any of it in when adding a problem, or later from the **All** tab (click a problem
  to open its card in a dialog; on a phone it comes up as a sheet). Close it with the ✕,
  Escape, or by clicking outside.
- The link is optional. Leave it blank and the app guesses the LeetCode URL from the
  problem name, which works for standard LeetCode titles. Set it explicitly for anything
  else and yours always wins.
- Editing a card never changes your review schedule.

Push to GitHub → Vercel auto-redeploys.

## Scaling notes

Supabase free tier: 500 MB database, unlimited API requests, 50k monthly active users, 4 auth emails/hour. You'll never come close to any of these for personal use.

If email throttling ever bothers you (probably won't, since sessions last weeks), plug in Resend or Postmark for SMTP — free tier there is 3k/month, plenty.
