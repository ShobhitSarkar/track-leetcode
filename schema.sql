-- Recall — Supabase schema
-- Paste this entire file into Supabase Dashboard → SQL Editor → New Query → Run

-- Table: one row per tracked problem
create table if not exists public.problems (
  id            text primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  name          text not null,
  pattern       text not null,
  url           text,
  solution      text,
  notes         text,
  solution_saved_at date,
  history       jsonb not null default '[]'::jsonb,
  next_review   date not null,
  created_at    date not null default current_date
);

-- Migration: adds the flashcard columns to a table created before they existed.
-- `create table if not exists` above is a no-op on an existing table, so these are
-- what actually add the columns for you. Safe to run repeatedly.
alter table public.problems add column if not exists url text;
alter table public.problems add column if not exists solution text;
alter table public.problems add column if not exists notes text;
alter table public.problems add column if not exists solution_saved_at date;

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

-- Table: suggestions the user hid from the Discover view, keyed by leetcode slug so
-- it stays stable regardless of how a problem's name is capitalized when it comes back.
-- Adding a row makes the Discover engine skip that slug and fill the slot with the
-- next best candidate; deleting the row (via the "reset skips" affordance) puts it
-- back in the candidate pool.
create table if not exists public.skipped_suggestions (
  user_id    uuid not null references auth.users(id) on delete cascade,
  slug       text not null,
  skipped_at timestamptz not null default now(),
  primary key (user_id, slug)
);

alter table public.skipped_suggestions enable row level security;

drop policy if exists "read own skips" on public.skipped_suggestions;
create policy "read own skips" on public.skipped_suggestions
  for select using (auth.uid() = user_id);

drop policy if exists "insert own skips" on public.skipped_suggestions;
create policy "insert own skips" on public.skipped_suggestions
  for insert with check (auth.uid() = user_id);

drop policy if exists "delete own skips" on public.skipped_suggestions;
create policy "delete own skips" on public.skipped_suggestions
  for delete using (auth.uid() = user_id);

-- Table: freeform notes. One row per note; a note may reference a problem row
-- via problem_id (nullable so concept notes that aren't tied to a specific
-- problem still fit). Cards generated from the note live in `flashcards` below
-- and are scheduled on the same 30/12/5/2 spaced-repetition rhythm the app
-- already uses for problems.
create table if not exists public.notes (
  id            text primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  problem_id    text references public.problems(id) on delete set null,
  title         text not null,
  topic         text,
  body          text not null default '',
  updated_at    timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

-- Migration: the first cut of this schema called the taxonomy column `pattern`
-- (borrowed from problems.pattern), but the app always used `topic` for a note
-- since a note isn't necessarily about a LeetCode pattern. `create table if not
-- exists` above is a no-op on an existing table, so this rename is what
-- actually fixes the column name for anyone who already ran the earlier
-- schema. Wrapped in a do-block so it's idempotent — it only fires when the
-- old column is still present.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'notes' and column_name = 'pattern'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'notes' and column_name = 'topic'
  ) then
    alter table public.notes rename column pattern to topic;
  end if;
end $$;

create index if not exists notes_user_updated_idx
  on public.notes (user_id, updated_at desc);

alter table public.notes enable row level security;

drop policy if exists "read own notes" on public.notes;
create policy "read own notes" on public.notes
  for select using (auth.uid() = user_id);
drop policy if exists "insert own notes" on public.notes;
create policy "insert own notes" on public.notes
  for insert with check (auth.uid() = user_id);
drop policy if exists "update own notes" on public.notes;
create policy "update own notes" on public.notes
  for update using (auth.uid() = user_id);
drop policy if exists "delete own notes" on public.notes;
create policy "delete own notes" on public.notes
  for delete using (auth.uid() = user_id);

-- Table: one row per flashcard. `front` is the prompt, `back` is what to recall,
-- `code` an optional monospaced snippet the back shows below the prose. Scheduling
-- mirrors problems: `history` is an append-only list of {date, rating}, `next_review`
-- the date the card is next due. `source` records how a card was made ('generated'
-- or 'manual') so the UI can show which came from the note's own body vs. what the
-- user typed themselves.
create table if not exists public.flashcards (
  id            text primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  note_id       text not null references public.notes(id) on delete cascade,
  front         text not null,
  back          text not null,
  code          text,
  source        text not null default 'manual',
  history       jsonb not null default '[]'::jsonb,
  next_review   date not null,
  created_at    date not null default current_date
);

create index if not exists flashcards_user_next_review_idx
  on public.flashcards (user_id, next_review);
create index if not exists flashcards_note_idx
  on public.flashcards (note_id);

alter table public.flashcards enable row level security;

drop policy if exists "read own flashcards" on public.flashcards;
create policy "read own flashcards" on public.flashcards
  for select using (auth.uid() = user_id);
drop policy if exists "insert own flashcards" on public.flashcards;
create policy "insert own flashcards" on public.flashcards
  for insert with check (auth.uid() = user_id);
drop policy if exists "update own flashcards" on public.flashcards;
create policy "update own flashcards" on public.flashcards
  for update using (auth.uid() = user_id);
drop policy if exists "delete own flashcards" on public.flashcards;
create policy "delete own flashcards" on public.flashcards
  for delete using (auth.uid() = user_id);
