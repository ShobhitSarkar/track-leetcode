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
- `THEMES` — color palette for light and dark
- `leetcodeUrlFor` — how a problem link is guessed from the name

## Flashcards

Each problem can hold the solution you actually wrote, your notes, and a link to the
problem itself. When it comes up for review, the card stays face down behind a
**Reveal solution** button so you attempt recall first, then check yourself, then rate.

- Fill any of it in when adding a problem, or later from the **All** tab (click a problem
  to expand it).
- The link is optional. Leave it blank and the app guesses the LeetCode URL from the
  problem name, which works for standard LeetCode titles. Set it explicitly for anything
  else and yours always wins.
- Editing a card never changes your review schedule.

Push to GitHub → Vercel auto-redeploys.

## Scaling notes

Supabase free tier: 500 MB database, unlimited API requests, 50k monthly active users, 4 auth emails/hour. You'll never come close to any of these for personal use.

If email throttling ever bothers you (probably won't, since sessions last weeks), plug in Resend or Postmark for SMTP — free tier there is 3k/month, plenty.
