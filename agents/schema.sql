-- JeetOS Agent Memory System — Supabase Schema
-- Run this once in Supabase SQL Editor (Project → SQL Editor → New Query)
-- Adds the tables psychologist.js and stake-manager.js need. Does NOT
-- touch your existing jeetos_logs table.

create table if not exists jeetos_excuse_log (
  id bigint generated always as identity primary key,
  task text not null,
  date date not null default current_date,
  reason_given text,
  reason_category text,
  solution_offered text,
  solution_applied boolean,
  repeat_count int default 1,
  waived boolean default true,
  stake_charged boolean default false,
  created_at timestamptz default now()
);

create index if not exists idx_excuse_log_task_date on jeetos_excuse_log (task, date desc);
create index if not exists idx_excuse_log_category on jeetos_excuse_log (reason_category, date desc);

create table if not exists jeetos_pattern_index (
  id bigint generated always as identity primary key,
  reason_category text not null,
  occurrences int default 1,
  last_solution_offered text,
  solution_ever_confirmed_applied boolean default false,
  linked_tasks text[],
  status text,
  updated_at timestamptz default now()
);

create table if not exists jeetos_stake_config (
  id bigint generated always as identity primary key,
  task text not null unique,
  amount numeric not null default 50,
  active boolean default true,
  created_at timestamptz default now()
);

-- Seed the 3 non-negotiable stake categories (edit amounts as you like,
-- or set active=false to pause any of them). Only tasks present here
-- with active=true get charged — everything else is never staked.
insert into jeetos_stake_config (task, amount, active) values
  ('protein_target', 50, true),
  ('gym_session', 75, true),
  ('sleep_window', 50, true)
on conflict (task) do nothing;

create table if not exists jeetos_stake_ledger (
  id bigint generated always as identity primary key,
  task text not null,
  date date not null default current_date,
  amount numeric default 0,
  waived boolean default true,
  reason text,
  created_at timestamptz default now()
);

create index if not exists idx_stake_ledger_date on jeetos_stake_ledger (date desc);
create index if not exists idx_stake_ledger_task_date on jeetos_stake_ledger (task, date desc);

create table if not exists jeetos_reward_pool (
  id bigint generated always as identity primary key,
  amount numeric not null,
  date date not null default current_date,
  note text,
  created_at timestamptz default now()
);

-- Row Level Security: these tables are only ever written to from your
-- Vercel serverless functions using the SERVICE ROLE key, so RLS can stay
-- locked down (no public read/write). If you ever call these tables
-- directly from the browser with the anon key, you'll need to add
-- policies — for now, leave RLS enabled with no policies (default deny).
alter table jeetos_excuse_log enable row level security;
alter table jeetos_pattern_index enable row level security;
alter table jeetos_stake_config enable row level security;
alter table jeetos_stake_ledger enable row level security;
alter table jeetos_reward_pool enable row level security;

-- Shared coach team memory, synced from the app (JeetOS.html) with the
-- publishable key, same open policy as jeetos_logs / jeetos_labels.
create table if not exists public.jeetos_team_memory (
  fact_key text primary key,
  fact text not null,
  from_coach text,
  created_on date not null default current_date,
  created_at timestamptz not null default now()
);
alter table public.jeetos_team_memory enable row level security;
create policy "allow all for anon" on public.jeetos_team_memory for all to public using (true) with check (true);

-- Promises Jeet makes to a coach in chat ("kal 6 baje gym"), so the coach
-- follows up when due. Written by the app with the publishable key.
create table if not exists public.jeetos_commitments (
  id text primary key,
  coach text not null,
  text text not null,
  due date not null,
  status text not null default 'open' check (status in ('open','done','missed')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
alter table public.jeetos_commitments enable row level security;
create policy "allow all for anon" on public.jeetos_commitments for all to public using (true) with check (true);

-- Coaches text first: api/coach-nudge.js (Vercel Cron) writes one message per
-- coach per slot per day; the app shows them as unread chats.
create table if not exists public.jeetos_coach_inbox (
  id bigserial primary key,
  coach text not null,
  slot text not null,
  text text not null,
  created_on date not null,
  created_at timestamptz not null default now(),
  read boolean not null default false,
  unique (coach, slot, created_on)
);
alter table public.jeetos_coach_inbox enable row level security;
create policy "allow all for anon" on public.jeetos_coach_inbox for all to public using (true) with check (true);

-- One measurable goal per coach ("bench 80kg by Dec"), with a progress log
-- the coaches use for throwbacks and the Sunday review.
create table if not exists public.jeetos_coach_goals (
  id text primary key,
  coach text not null,
  text text not null,
  unit text,
  start_value numeric,
  target numeric,
  current_value numeric,
  deadline date,
  status text not null default 'active' check (status in ('active','achieved','dropped')),
  history jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.jeetos_coach_goals enable row level security;
create policy "allow all for anon" on public.jeetos_coach_goals for all to public using (true) with check (true);

-- Shared history with each coach: nicknames, inside jokes, wins.
create table if not exists public.jeetos_coach_moments (
  id text primary key,
  coach text not null,
  kind text not null default 'moment' check (kind in ('moment','nickname','joke','win')),
  text text not null,
  created_on date not null default current_date,
  created_at timestamptz not null default now()
);
alter table public.jeetos_coach_moments enable row level security;
create policy "allow all for anon" on public.jeetos_coach_moments for all to public using (true) with check (true);
