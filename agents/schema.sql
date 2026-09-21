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
