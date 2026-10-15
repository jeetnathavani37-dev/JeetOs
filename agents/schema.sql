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

-- Weekly check-in reports (photos stay on the phone; only the written
-- reviews, scores and stats are stored here).
create table if not exists public.jeetos_checkins (
  id text primary key,
  created_on date not null default current_date,
  note text,
  slots text[] not null default '{}',
  stats jsonb,
  reviews jsonb,
  summary jsonb,
  created_at timestamptz not null default now()
);
alter table public.jeetos_checkins enable row level security;
create policy "allow all for anon" on public.jeetos_checkins for all to public using (true) with check (true);

-- Long-term memory: one evolving profile of Jeet (built by the app's memory
-- pass from all chats) and short dated summaries of older conversations.
create table if not exists public.jeetos_profile (
  id text primary key default 'jeet',
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.jeetos_profile enable row level security;
create policy "allow all for anon" on public.jeetos_profile for all to public using (true) with check (true);

create table if not exists public.jeetos_convo_summaries (
  id text primary key,
  coach text not null,
  from_ts bigint not null,
  to_ts bigint not null,
  summary text not null,
  created_at timestamptz not null default now()
);
alter table public.jeetos_convo_summaries enable row level security;
create policy "allow all for anon" on public.jeetos_convo_summaries for all to public using (true) with check (true);

-- PhD-style scorecards: each coach scores Jeet on 8-10 parameters with a
-- goal timeline (from "Full assessment" or each weekly check-in).
create table if not exists public.jeetos_assessments (
  id text primary key,
  coach text not null,
  data jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.jeetos_assessments enable row level security;
create policy "allow all for anon" on public.jeetos_assessments for all to public using (true) with check (true);

-- Encrypted photo backups (AES-GCM on the phone; the key is the user's backup
-- code and never reaches the server).
create table if not exists public.jeetos_photo_vault (
  key text primary key,
  iv text not null,
  data text not null,
  created_at timestamptz not null default now()
);
alter table public.jeetos_photo_vault enable row level security;
create policy "allow all for anon" on public.jeetos_photo_vault for all to public using (true) with check (true);

-- Who made the promise: 'jeet' (his commitment) or 'coach' (a follow-up the coach owes him).
alter table public.jeetos_commitments add column if not exists owner text not null default 'jeet';

-- Coaches messaging each other behind the scenes (<tell> tags + daily huddle).
create table if not exists public.jeetos_coach_notes (
  id text primary key,
  from_coach text not null,
  to_coach text not null,
  text text not null,
  source text not null default 'chat',
  created_at timestamptz not null default now()
);
alter table public.jeetos_coach_notes enable row level security;
create policy "allow all for anon" on public.jeetos_coach_notes for all to public using (true) with check (true);

-- Focus board: one major focus goal per department + flagged issues.
alter table public.jeetos_coach_goals add column if not exists focus boolean not null default false;
alter table public.jeetos_coach_goals add column if not exists plan jsonb;
create table if not exists public.jeetos_flags (
  id text primary key,
  coach text not null,
  text text not null,
  severity text not null default 'med',
  evidence text,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
alter table public.jeetos_flags enable row level security;
create policy "allow all for anon" on public.jeetos_flags for all to public using (true) with check (true);

-- Head Coach: decision log / approved master plan versions, and safety events.
create table if not exists public.jeetos_decisions (
  id text primary key, coach text not null, area text, change text not null, reason text, evidence text,
  source text not null default 'chat', status text not null default 'pending', version int,
  created_at timestamptz not null default now(), decided_at timestamptz
);
alter table public.jeetos_decisions enable row level security;
create policy "allow all for anon" on public.jeetos_decisions for all to public using (true) with check (true);
create table if not exists public.jeetos_safety_events (
  id text primary key, coach text, trigger text not null, severity text not null default 'med', created_at timestamptz not null default now()
);
alter table public.jeetos_safety_events enable row level security;
create policy "allow all for anon" on public.jeetos_safety_events for all to public using (true) with check (true);

-- Bottleneck engine: blockers on missed promises, hypotheses, and experiments with outcomes.
alter table public.jeetos_commitments add column if not exists blocker text;
create table if not exists public.jeetos_bottlenecks (
  id text primary key, coach text not null, category text not null, hypothesis text not null, evidence text,
  instances int not null default 1, confidence text not null default 'low', status text not null default 'suspected',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table public.jeetos_bottlenecks enable row level security;
create policy "allow all for anon" on public.jeetos_bottlenecks for all to public using (true) with check (true);
create table if not exists public.jeetos_experiments (
  id text primary key, coach text not null, action text not null, target text, baseline text, criterion text,
  review_date date, status text not null default 'running', outcome text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table public.jeetos_experiments enable row level security;
create policy "allow all for anon" on public.jeetos_experiments for all to public using (true) with check (true);

-- Streak protection: minimum-win / recovery marks per day and habit.
create table if not exists public.jeetos_streak_marks (
  id text primary key, date date not null, habit text not null, kind text not null, reason text, created_at timestamptz not null default now()
);
alter table public.jeetos_streak_marks enable row level security;
create policy "allow all for anon" on public.jeetos_streak_marks for all to public using (true) with check (true);

-- Goal execution engine: one primary goal at a time (single row id 'jeet').
create table if not exists public.jeetos_goal_state (id text primary key, data jsonb not null, updated_at timestamptz not null default now());
alter table public.jeetos_goal_state enable row level security;
create policy "allow all for anon" on public.jeetos_goal_state for all to public using (true) with check (true);

-- Truth engine: claims checked against records (verified / self_reported / inconsistent / incomplete / unknown / corrected / honest_miss).
create table if not exists public.jeetos_claims (
  id text primary key, coach text, type text not null, claimed text not null, value numeric, unit text, day text,
  status text not null, evidence text, correction jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table public.jeetos_claims enable row level security;
create policy "allow all for anon" on public.jeetos_claims for all to public using (true) with check (true);

-- iPhone / web push subscriptions.
create table if not exists public.jeetos_push_subs (
  endpoint text primary key, p256dh text not null, auth text not null, ua text,
  created_at timestamptz not null default now(), last_ok_at timestamptz
);
alter table public.jeetos_push_subs enable row level security;
create policy "allow all for anon" on public.jeetos_push_subs for all to public using (true) with check (true);

-- Daily record (build -69): ISO day for range queries, haircare flag.
-- NULL now means "not logged" (the app sends null instead of form defaults / 0).
alter table public.jeetos_logs add column if not exists day date;
alter table public.jeetos_logs add column if not exists haircare_done boolean;
update public.jeetos_logs set day = to_date(substr(date, 5), 'Mon DD YYYY') where day is null;
create index if not exists jeetos_logs_day_idx on public.jeetos_logs (day);

-- Login (build -70): only users listed in jeetos_owners can touch jeetos_* data.
create table if not exists public.jeetos_owners (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.jeetos_owners enable row level security;  -- no policies: service role only
create or replace function public.jeetos_is_owner() returns boolean
language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.jeetos_owners where user_id = auth.uid()) $$;
revoke all on function public.jeetos_is_owner() from public;
grant execute on function public.jeetos_is_owner() to anon, authenticated;
-- On every jeetos_* table:
--   create policy "owner full access" on public.<table> for all to authenticated
--     using ((select public.jeetos_is_owner())) with check ((select public.jeetos_is_owner()));
-- Lockdown (after the owner is registered and the server has SUPABASE_SERVICE_ROLE_KEY):
--   drop policy "allow all for anon" on public.<table>;

-- Penalty ledger v1 (build -71, SIMULATION — no money moves). Owner can only read;
-- every write is done by api/penalty.js with the server key.
--   jeetos_penalty_policies(version pk, mode, rules jsonb, status, effective_from, confirmed_at)
--   jeetos_penalty_incidents(id pk, source_key unique, commitment_id, category promise|log, root_key, policy_version, status, overlap_of, title, detail)
--   jeetos_penalty_entries(id, incident_id, kind, day_n, local_date, amount_paise bigint, calc jsonb, policy_version,
--                          unique (incident_id, kind, local_date))  -- append-only trigger
--   jeetos_audit_events(...)  -- append-only trigger
--   jeetos_engine_lock(id, locked_until)  -- one engine run at a time
--   policies "owner read" (select, jeetos_is_owner()) on the four ledger tables; no insert/update/delete policies.
-- jeetos_commitments: + deadline_at, tz, staked, agreed_at, policy_version, done_at;
--   trigger jeetos_commitments_guard: only the server can stake / unstake / set the deadline,
--   staked promises can't be edited or deleted by the client, done_at/resolved_at use the server clock.
-- jeetos_logs: + entries jsonb (phone's first-seen time per required entry), entries_seen jsonb
--   (trigger jeetos_logs_seen stamps the server receipt time once per entry; the client can't set it).

-- Manual UPI (build -72): he pays in his own UPI app; status is self-reported (UTR), never auto-debit.
--   jeetos_payees(id 'charity', name, vpa check format, source_confirmed)
--   jeetos_payments(id, kind test|settlement, amount_paise >0, payee_name, payee_vpa,
--                   status initiated|reported_paid|verified|failed|cancelled, utr unique, ...)
--   owner read only; writes via api/penalty.js (set_payee, pay_test_start, pay_report, pay_cancel).

-- Weekly settlement (build -73): jeetos_payees vpa check uses {2,255} (Postgres max repeat 255).
-- Real money only under a policy with mode='live' (go_live needs the owner to type LIVE; it adds a
-- new policy version from now). dues = live-policy entries − settlement payments reported paid.
-- Sunday after 12:00 IST the ledger cron sends one settle-up notice (inbox coach=ronaldo slot=settle + push).

-- Phase 2 (build -74): monthly passes for gym rest (7, Mon–Sat), diet (4), sleep (4); IST month, no rollover.
-- jeetos_penalty_incidents: category += gym|diet|sleep; status += allowance.
-- jeetos_logs: + junk_meals int, bedtime text (as entered); entries.workout stamped like the other entries.
-- jeetos_allowance_uses(id, category, month, day, kind planned|auto, status used|released, incident_id, ...)
--   unique (category, day) where status='used'; owner read only.
-- jeetos_use_allowance(category, day, kind, incident, limit) / jeetos_release_allowance(category, day):
--   security definer, advisory lock per category+month, service_role only.

-- Phase 3 (build -75): evidence + disputes. Owner read only; writes via api/penalty.js.
--   jeetos_evidence(id 'ev_'+sha256 prefix, kind proof_photo|dispute_photo|note, day, proof_key, vault_key,
--                   sha256, incident_id, dispute_id, status, ai_analysis, received_at server time) — no delete.
--     The image itself lives only in the encrypted jeetos_photo_vault (key proof:<day>:<card> / dispute:...).
--   jeetos_disputes(id, incident_id → incidents, category tech_issue|did_it|wrong_data|ill|other, reason,
--                   prev_status, status open|upheld|rejected|need_more, review jsonb, created_at, decided_at)
--     Max 2 per incident. While disputed the fine is excluded from dues. Upheld → reversal entries
--     (originals kept), incident excused, its pass released. Rejected → previous status.
