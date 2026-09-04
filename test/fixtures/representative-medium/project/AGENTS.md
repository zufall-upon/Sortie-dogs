# Representative benchmark fixture

- For task `representative-medium-sol-serial`, implement all five `input/unit-N.md` contracts sequentially
  and write only the five matching `output/unit-N.mjs` paths.
- For a Luna unit task, implement exactly its assigned `input/unit-N.md` contract and write only the
  matching `output/unit-N.mjs` path.
- Do not change tests, inputs, manifests, validation, or an output outside the assigned task.
- Run `node validate.mjs` for the serial task or the assigned `node --test test/unit-N.test.mjs` command for
  a Luna unit before returning evidence.
