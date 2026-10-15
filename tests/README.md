# Tests

No dependencies — run with Node 18+:

```
node tests/penalty.test.js       # rules engine (api/_penalty.js): doubling, grace, caps, overlap, IST month boundary
node tests/penalty-api.test.js   # api/penalty.js against an in-memory DB: auth, staking, cron idempotency
node tests/context.test.js       # shared context engine (api/_context.js): packet, access matrix, unknowns, budget, IST plan day
node tests/ai-context.test.js    # api/ai.js: owner-only context, packet in the live prompt block, DB-down fallback
node tests/coach-nudge.test.js   # cron coaches use the same packet (newest memory, scoped ledger)
node tests/memory.test.js        # Memory v2: rules, api/os.js against an in-memory table, what coaches see
```

Every line should start with `PASS`.
