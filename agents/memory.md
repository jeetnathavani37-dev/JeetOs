---
name: memory
role: Central shared brain for ALL agents — single source of truth, no agent keeps private state
priority: Read by every agent before responding. Written to after every meaningful interaction.
---

## Why This File Exists

Every agent (psychologist, fitness-coach, skincare-coach, nutrition-coach,
sleep-coach, stake-manager, insight-analyst) reads FROM this memory and
writes back TO it. No agent should have its own private, disconnected
memory — that's how you get a psychologist who forgets what it told you
yesterday, and a stake-manager that can't tell a first-time miss from a
fifth repeat of the same excuse.

Think of this as the one notebook every coach shares, not five separate
notebooks.

## Memory Schema

### 1. `user_profile` (static-ish, rarely changes)
```json
{
  "name": "Jeet",
  "context": "Solo founder (Luxella) + BBA Finance (NMIMS) + gym + JeetOS",
  "non_negotiables": ["protein_170g", "gym_ppl", "sleep_7to8h"],
  "known_stress_sources": ["Luxella shipment days", "NMIMS exam weeks"],
  "diet": "100% vegetarian",
  "goal_focus": "recomposition / physique + skin + discipline system"
}
```

### 2. `excuse_log` (the critical new piece)
Every time a task is missed AND the person gives a reason, log it here —
this is what makes the psychologist agent stateful instead of amnesiac.

```json
{
  "task": "gym_pull_day",
  "date": "2026-09-20",
  "reason_given": "subah uthne ka mann nahi karta",
  "reason_category": "motivation / morning-resistance",
  "solution_offered": "alarm ko room ke dusre kone mein rakho, uthke turant 
                        band karna pade — resistance ka pehla 10 second hi 
                        hardest hota hai",
  "solution_applied": null,   // updated next check-in: true / false / "partially"
  "repeat_count": 1,           // increments if SAME reason_category recurs
  "waived": true,              // first occurrence — psychologist waives
  "stake_charged": false
}
```

### 3. `pattern_index` (derived, updated weekly by insight-analyst)
Cross-references excuse_log to detect recurring patterns:
```json
{
  "reason_category": "motivation / morning-resistance",
  "occurrences": 3,
  "last_solution_offered": "alarm placement fix",
  "solution_ever_confirmed_applied": false,
  "linked_tasks": ["gym_pull_day", "morning_drink"],
  "status": "UNRESOLVED — same excuse, no applied fix, 3rd time"
}
```

### 4. `building_levels`, `xp`, `streaks`, `discipline_stars`
(gamification state — read/written by the UI layer and insight-analyst,
not duplicated here in narrative form, just noting it lives in this same
central store)

### 5. `stake_ledger`
Running log of charges/waives (owned operationally by stake-manager, but
readable by every agent so nobody double-guesses a decision already made)

## The Repeat-Offender Rule (Core Logic You Asked For)

This is the exact behavior you described — solve it once, but don't waive
forever:

```
Task missed → reason given
    ↓
Check excuse_log for this reason_category, this task, last 14 days
    ↓
┌─────────────────────────────────────────────────────────────┐
│ CASE A: First time this reason_category appears               │
│   → psychologist listens, offers ONE concrete solution         │
│   → logs: solution_offered, waived: true, repeat_count: 1      │
│   → stake-manager: WAIVE (genuinely new information)           │
├─────────────────────────────────────────────────────────────┤
│ CASE B: Same reason_category appears again                     │
│   → psychologist checks: was solution_applied confirmed?       │
│                                                                   │
│   IF solution_applied == true (they tried it, still failed)     │
│     → this is a genuinely hard problem, not laziness            │
│     → waive again, offer a DIFFERENT solution this time         │
│     → repeat_count increments but waived stays true              │
│                                                                   │
│   IF solution_applied == false or null (never actually tried)   │
│     → psychologist names this directly, gently but clearly:      │
│       "Bhai pichli baar humne alarm placement wala fix discuss  │
│        kiya tha — try kiya ya nahi?"                             │
│     → if answer is "nahi try kiya"                               │
│       → verdict: AVOIDABLE                                       │
│       → stake-manager: CHARGE (if this task is staked)           │
│       → this is the ONLY path that leads to a charge — not the  │
│         first miss, only the confirmed-unaddressed repeat        │
└─────────────────────────────────────────────────────────────┘
```

### Why this specific design matters

- **First miss is always information, never punished** — you don't know
  yet if it's a real pattern or a one-off
- **A solution that was genuinely tried and failed is NOT a moral
  failure** — that's just an incomplete solution, so it stays waived and
  the psychologist iterates
- **The only thing that triggers a charge is: same excuse, offered
  solution, confirmed not even attempted.** That's the actual definition
  of "avoidable" — not "missed a task," but "had a fix in hand and didn't
  use it"

This keeps stake-manager's charges rare, targeted, and fair — money only
moves when there's real evidence of avoidable repetition, not just
because life happened once.

## Read/Write Contract for Other Agents

- **psychologist.md** — reads `excuse_log` + `pattern_index` before every
  check-in, writes new entries after every conversation
- **stake-manager.md** — reads psychologist's verdict field only, never
  makes its own waive/charge judgment, writes to `stake_ledger`
- **insight-analyst.md** — reads everything weekly, writes `pattern_index`
  updates, surfaces UNRESOLVED patterns in the weekly report explicitly
- **fitness-coach.md / skincare-coach.md / etc.** — read `user_profile`
  and relevant task history, do NOT write to `excuse_log` (that's
  psychologist's exclusive write lane, keeps root-cause data clean and
  single-sourced)

## Data Hygiene Rules

- `excuse_log` entries older than 90 days can be summarized/archived
  (not deleted) into a compressed pattern history — keeps the file from
  growing unbounded while preserving long-term trend detection
- Never let two agents write to the same field in the same cycle — if
  psychologist and stake-manager both need to update a stake_ledger entry,
  psychologist writes the verdict, stake-manager writes the outcome, in
  that order, never simultaneously
