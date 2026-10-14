# Tests

No dependencies — run with Node 18+:

```
node tests/penalty.test.js       # rules engine (api/_penalty.js): doubling, grace, caps, overlap, IST month boundary
node tests/penalty-api.test.js   # api/penalty.js against an in-memory DB: auth, staking, cron idempotency
```

Every line should start with `PASS`.
