# Writing style

## Prose

- No empty modifiers ("robust", "powerful", "seamless"…).
- No "not X but Y" contrast unless the user asks for it.
- Practical first. Cut anything that doesn't change what the reader does next.

## Code

- Default to no comments. Add one only when WHY is non-obvious: hidden invariant, workaround, surprising behaviour. Names already explain WHAT.
- No "added for task X" or "called by Y" comments — that's PR description material, and it rots.
- Don't introduce features, refactors, or backwards-compat shims beyond what the task requires.
- Three similar lines beats a premature abstraction.
- Validate only at boundaries (user input, external APIs). Trust internal callers and framework guarantees.
- No unused imports, exports, variables, parameters, or helper functions. After editing a file, check what you removed callers for and delete the now-orphaned imports/declarations in the same change. `grep -cw "<sym>" <file>` returning 1 means the symbol appears only on its import line — drop it. Keep imports collapsed: prefer one `import { a, b } from 'x'` over two lines from the same module.

## Output

- Don't create planning/decision documents unless asked.
- Don't summarise what the diff already shows. End-of-turn: one or two sentences max.
