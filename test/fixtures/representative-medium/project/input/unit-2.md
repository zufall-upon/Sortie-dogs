# Unit 2: retry schedule

Create `output/unit-2.mjs` and export `retrySchedule(options)`.

`options` contains `attempts`, `baseDelayMs`, optional `factor` defaulting to `2`, and optional
`maxDelayMs` defaulting to `30000`.

Requirements:

- Return one delay for each retry, so `attempts: 1` returns an empty array.
- The first retry uses `baseDelayMs`; each later retry multiplies the previous uncapped delay by `factor`.
- Cap every returned delay at `maxDelayMs`.
- Return integer millisecond values using `Math.round` after capping.
- Require integer `attempts` from 1 through 10.
- Require finite positive values for all delay and factor fields.
- Return a new array on every call and do not mutate `options`.

Acceptance command: `node --test test/unit-2.test.mjs`.
