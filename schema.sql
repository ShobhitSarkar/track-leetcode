-- Recall — Supabase schema
-- Paste this entire file into Supabase Dashboard → SQL Editor → New Query → Run

-- Table: one row per tracked problem
create table if not exists public.problems (
  id            text primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  name          text not null,
  pattern       text not null,
  history       jsonb not null default '[]'::jsonb,
  next_review   date not null,
  created_at    date not null default current_date
);

-- Index for the app's main query (my problems, soonest first)
create index if not exists problems_user_next_review_idx
  on public.problems (user_id, next_review);

-- Row Level Security — a user can only touch their own rows
alter table public.problems enable row level security;

drop policy if exists "read own problems" on public.problems;
create policy "read own problems" on public.problems
  for select using (auth.uid() = user_id);

drop policy if exists "insert own problems" on public.problems;
create policy "insert own problems" on public.problems
  for insert with check (auth.uid() = user_id);

drop policy if exists "update own problems" on public.problems;
create policy "update own problems" on public.problems
  for update using (auth.uid() = user_id);

drop policy if exists "delete own problems" on public.problems;
create policy "delete own problems" on public.problems
  for delete using (auth.uid() = user_id);
