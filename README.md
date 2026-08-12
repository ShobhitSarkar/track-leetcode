# Recall — Deploy Guide (Supabase + Vercel)

Cloud-synced spaced repetition tracker for LeetCode. Google login, works on any device with your account.

## The 8-step overview

You'll do these in order. Total time: ~25–40 min if you've never used Supabase, less if you have.

1. Create Supabase project
2. Run the schema SQL
3. Set up Google OAuth (Google Cloud + Supabase)
4. Put your Supabase creds into `index.html`
5. Push to GitHub
6. Deploy to Vercel
7. Point Supabase's redirect URLs at your Vercel URL
8. Sign in and add to home screen

---

## 1. Create Supabase project

You said you've done this. If not: [supabase.com](https://supabase.com) → New project → any name → any region near you → set a database password (save it somewhere). Wait ~2 min for provisioning.

## 2. Run the schema

- Open your project → left sidebar → **SQL Editor** → **New query**
- Open `schema.sql` from this folder, paste the whole thing, click **Run**
- You should see "Success. No rows returned." That's correct — it created the table, index, and RLS policies

Verify: sidebar → **Table Editor** → you should see a `problems` table with the right columns.

## 3. Set up Google OAuth

This is the fiddliest step. You're doing two things: creating an OAuth app in Google Cloud, then connecting it to Supabase.

### 3a. Get Supabase's callback URL

- Supabase → sidebar → **Authentication** → **Providers** → click **Google**
- Copy the **Callback URL (for OAuth)** — looks like `https://YOURPROJECT.supabase.co/auth/v1/callback`
- Keep this tab open

### 3b. Create Google OAuth credentials

- Go to [console.cloud.google.com](https://console.cloud.google.com)
- Create a new project (top-left dropdown → New Project → name it "Recall")
- Left sidebar → **APIs & Services** → **OAuth consent screen**
  - User Type: **External** → Create
  - App name: Recall, User support email: yours, Developer contact: yours → Save and Continue
  - Scopes: skip → Save and Continue
  - Test users: add your Google email → Save and Continue
- Left sidebar → **Credentials** → **Create Credentials** → **OAuth client ID**
  - Application type: **Web application**
  - Name: Recall
  - Authorized redirect URIs: paste the Supabase callback URL from step 3a
  - Create
- Copy the **Client ID** and **Client Secret** from the popup

### 3c. Paste into Supabase

- Back in the Supabase Google provider tab
- Enable the provider (toggle on)
- Paste Client ID and Client Secret
- Save

## 4. Put your Supabase creds into `index.html`

- Supabase → sidebar → **Project Settings** (gear icon) → **API**
- Copy **Project URL** and **anon public** key
- Open `index.html`, find these lines near the top:

```js
const SUPABASE_URL = 'https://YOUR_PROJECT.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY_HERE';
```

Replace both with your actual values. Both are safe to commit publicly — the anon key is designed to be exposed, and the Row Level Security policies from step 2 keep your data safe.

## 5. Push to GitHub

Easiest way (no local git needed):

- Go to [github.com/new](https://github.com/new)
- Repo name: `recall` (public or private, doesn't matter)
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

## 6. Deploy to Vercel

- Go to [vercel.com/new](https://vercel.com/new)
- If it's your first time, sign in with GitHub and authorize
- Import the `recall` repo
- Framework Preset: **Other** (Vercel will auto-detect it as a static site)
- Leave everything else as default
- Click **Deploy**
- ~15 seconds later you get a URL like `https://recall-xyz.vercel.app`

Copy that URL — you need it in step 7.

## 7. Point Supabase at your Vercel URL

- Supabase → **Authentication** → **URL Configuration**
- **Site URL**: paste your Vercel URL (e.g. `https://recall-xyz.vercel.app`)
- **Redirect URLs**: add the same URL. Also add `http://localhost:3000` and `http://localhost:5173` if you'll ever run it locally
- Save

## 8. Sign in and install

- Open your Vercel URL in Safari (iPhone) or Chrome (Android)
- Tap **Continue with Google** — first time will show a "not verified app" warning since you're in test mode. Click **Advanced → Go to Recall (unsafe)** — this only shows because your OAuth app hasn't been submitted for Google review. Your data is safe; only you can access it because you're the only test user.
- You land in the app. Add a few problems.
- Add to home screen:
  - **iPhone Safari**: Share → Add to Home Screen
  - **Android Chrome**: menu → Install app

Done. Same login on your laptop = same queue.

---

## When something breaks

**"Sign in redirects but comes back to the sign-in screen"**
Redirect URL isn't in Supabase's allow-list. Re-check step 7 — the Vercel URL must match exactly (including https://) and be in both Site URL and Redirect URLs.

**"Failed to save: new row violates row-level security"**
RLS policies didn't get created. Re-run `schema.sql`.

**"This app hasn't been verified" every sign-in**
You're on Google's testing tier, which is fine forever for personal use. To remove the warning you'd need to submit the app for Google verification (not worth it for a personal tool).

**Data not syncing between devices**
Both devices logged in with the same Google account? Try sign-out + sign-in.

## Customizing later

Everything's in `index.html`:
- `RATING_INTERVALS` — days per rating
- `RATING_LABELS` — rename the ratings
- `COMMON_PATTERNS` — pattern chips
- `THEMES` — colors

Push to GitHub → Vercel auto-redeploys.

## Scaling notes

Supabase free tier gives you 500MB database, 2GB bandwidth, 50k monthly active users. You'll never come close.
