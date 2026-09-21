# JeetOS Agent System — Integration Guide

This is what makes the `/agents/*.md` architecture actually run, not just
sit there as documentation. Three new backend files were added — follow
these steps in order.

## Step 1 — Run the Database Schema

1. Go to your Supabase project → **SQL Editor** → New Query
2. Paste the contents of `schema.sql` (in this same folder) and run it
3. This adds 5 new tables: `jeetos_excuse_log`, `jeetos_pattern_index`,
   `jeetos_stake_config`, `jeetos_stake_ledger`, `jeetos_reward_pool` —
   your existing `jeetos_logs` table is untouched
4. `jeetos_stake_config` comes pre-seeded with 3 categories (protein,
   gym, sleep at ₹50/₹75/₹50 per miss) — edit amounts directly in
   Supabase Table Editor, or set `active = false` on any row to pause it

## Step 2 — Add the Two New API Files

Copy these into your repo's `/api/` folder (they're currently sitting in
`/agents/` as drafts so you can review them first):

- `psychologist-endpoint.js` → rename to `api/psychologist.js`
- `stake-manager-endpoint.js` → rename to `api/stake-manager.js`

Also **replace** your existing `api/telegram-weekly-report.js` with the
version in `/agents/telegram-weekly-report.js` — it's the same file with
the unresolved-pattern and stake-summary sections added at the end. Your
existing grade logic is untouched.

## Step 3 — Environment Variables (Vercel → Settings → Environment Variables)

You likely already have most of these set (since `ai.js` and the
Telegram files already use them). Confirm these exist:

| Variable | Used by |
|---|---|
| `ANTHROPIC_API_KEY` (or `CLAUDE_KEY`) | psychologist.js |
| `SUPABASE_URL` | psychologist.js, stake-manager.js |
| `SUPABASE_SERVICE_ROLE_KEY` | psychologist.js, stake-manager.js |
| `TELEGRAM_BOT_TOKEN` | stake-manager.js (charge notifications) |
| `TELEGRAM_CHAT_ID` | stake-manager.js |
| `STAKE_WEEKLY_CAP` (optional, default 1000) | stake-manager.js |

## Step 4 — Wire It Into JeetOS.html

This is the one piece that has to happen inside your existing 1MB
`JeetOS.html` file, wherever you currently mark a task as "missed" and
(if you have one) collect a reason from the user. The exact hook point
depends on your current UI code, but the calls themselves are simple —
two `fetch()` calls, chained:

```javascript
// 1. Call psychologist FIRST whenever a task is marked missed and you
//    have a reason from the user (e.g. from a text input or quick-reply)
async function handleMissedTask(taskId, reasonText) {
  const psychResponse = await fetch('/api/psychologist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      task: taskId,        // e.g. "gym_pull_day", "protein_target", "sleep_window"
      reasonGiven: reasonText
    })
  }).then(r => r.json());

  // Show psychResponse.message to the user in your UI — this is the
  // actual psychologist reply, already in Hinglish, ready to display

  // 2. THEN call stake-manager with whatever verdict psychologist gave —
  //    never skip straight to stake-manager on your own
  const stakeResponse = await fetch('/api/stake-manager', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      task: taskId,
      verdict: psychResponse.verdict,          // "waive" or "charge"
      reasonCategory: psychResponse.reasonCategory
    })
  }).then(r => r.json());

  // If stakeResponse.charged is true, you already got a Telegram
  // notification automatically — no need to show anything extra in the
  // UI unless you want to (e.g. update a "stakes this week" display)

  if (stakeResponse.waiveRateFlag) {
    // Optional: surface this in your UI — it means this task's stake
    // may be miscalibrated (waived >50% of the time over 2 weeks)
  }
}
```

**Important**: only call this for tasks that are in your `non_negotiables`
list (protein, gym, sleep) if you want the stake system active — but you
can call `/api/psychologist` alone (skip the stake-manager call) for ANY
missed task, including skincare/supplements, if you just want the
memory-aware check-in without any money involved. The psychologist
endpoint works standalone; stake-manager is opt-in per task via
`jeetos_stake_config`.

## Step 5 — Test Before Trusting It

1. Manually POST to `/api/psychologist` with a test task/reason (Postman,
   or even a browser fetch in devtools) and confirm you get a sensible
   JSON response back
2. Check Supabase Table Editor → `jeetos_excuse_log` to confirm the row
   was written
3. Repeat the same task/reason a second time and confirm the response
   now references your prior solution (this is the "does it actually
   remember" test)
4. Only after that, wire it into the real UI

## What's Still Manual (By Design)

- The domain coach `.md` files (`fitness-coach.md`, `skincare-coach.md`,
  etc.) are not yet wired to their own endpoints — they're reference
  documents for now. If you want them live too (e.g. an in-app chat that
  answers gym questions using fitness-coach.md's rules), that's a
  follow-up: same pattern as psychologist.js, but reading a different
  system prompt and without the memory/verdict logic.
- `insight-analyst.md`'s full weekly report (with the game-tape style
  6-section format) is only partially implemented — the current
  `telegram-weekly-report.js` update adds the unresolved-pattern and
  stake sections on top of your EXISTING grade system, rather than
  replacing it with an AI-generated version. A fully AI-written weekly
  report (calling Claude to write the whole thing, not just append two
  data sections) is a reasonable next step once you've seen a few weeks
  of the current hybrid version and like the data it's pulling.
