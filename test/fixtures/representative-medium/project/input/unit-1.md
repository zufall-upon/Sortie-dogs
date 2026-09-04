# Unit 1: argument validation

Create `output/unit-1.mjs` and export `parsePositiveInteger(value, name = "value")`.

Requirements:

- Accept a positive safe integer supplied as a number.
- Accept an ASCII decimal digit string without signs, whitespace, separators, or decimal points.
- Return the normalized number.
- Reject zero, negative values, unsafe integers, non-integers, empty strings, and non-string/non-number values.
- Throw `TypeError` for an unsupported value type or malformed string.
- Throw `RangeError` for a numeric value outside the positive safe-integer range.
- Include the supplied argument name in every error message.
- Do not read environment or filesystem state.

Acceptance command: `node --test test/unit-1.test.mjs`.
