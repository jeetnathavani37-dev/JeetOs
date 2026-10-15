# Tests

No dependencies — run with Node 18+:

```
node tests/penalty.test.js       # rules engine (api/_penalty.js): doubling, grace, caps, overlap, IST month boundary
node tests/penalty-api.test.js   # api/penalty.js against an in-memory DB: auth, staking, cron idempotency
node tests/context.test.js       # shared context engine (api/_context.js): packet, access matrix, unknowns, budget, IST plan day
node tests/ai-context.test.js    # api/ai.js: owner-only context, packet in the live prompt block, DB-down fallback
node tests/coach-nudge.test.js   # cron coaches use the same packet (newest memory, scoped ledger)
node tests/memory.test.js        # Memory v2: rules, api/os.js against an in-memory table, what coaches see
node tests/planner.test.js       # adaptive daily plan: misses re-slotted, minimum versions, priorities, /api/os?action=today
node tests/notify.test.js        # notification budget: cap, quiet hours, nudge gap, alarms always ring, settings endpoint
node tests/checkin.test.js       # daily check-in: adaptive questions, validation, log overlay, plan + packet, endpoint
node tests/habits.test.js        # habit consistency: 7/30-day %, unknown ≠ miss, recovery excused, minimum credited, blockers
node tests/insights.test.js      # patterns with sample sizes (sleep→gym, wake→gym, energy→plan, weekdays, before/after) + decision journal
node tests/repair.test.js        # plan repair: slip detection, approve from tomorrow, engine/context/planner/alarm honour it, endpoint
node tests/goals.test.js         # goal graph: health maths, roll-up, approval, target limits, endpoint, packet
```

Every line should start with `PASS`.
