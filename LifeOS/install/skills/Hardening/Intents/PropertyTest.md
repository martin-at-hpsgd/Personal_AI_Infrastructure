# PropertyTest

Property-based tests in fast-check for functions whose shape supports a universal claim, landed as `bun-property` ISCs in the ISA's Test Strategy or as shrunk counterexamples that become new example-based regression tests.

## Ideal State

- Every function given a property test matches at least one candidate shape under Inputs (pure function, parser/serializer pair, data transform, math or accumulator, collection operation, two implementations of the same thing, state machine with legal-sequence invariants); when none applies, no property test is written and the ISC uses the `bun-test` example form.
- Each property is written down in prose as a universal claim ("for all X, P(X) holds") and is the strongest of the ten property categories that apply to the function, since often two or three apply.
- Each generator's constraints reflect the function's actual valid input domain, no wider and no narrower, and `numRuns` follows the budget: 1000 by default, 10000 for invariant-critical properties, 100 for slow generators.
- A landed property lives in one new test file at `test/<surface>/<name>.property.test.ts`, runs under `bun test` with the `./` path prefix, and has one new `bun-property` row in the ISA's `## Test Strategy` pointing at that file.
- A failing property ends with its shrunk counterexample and seed captured and with either the code fixed (the counterexample revealed a bug) or the property fixed (the counterexample revealed the property was wrong).
- A counterexample found and fixed has one new C/R/L entry in the ISA's `## Learning`; a counterexample kept as a regression example is an example test with the seed pinned in a `// fc seed: 0x...` comment and one new `bun-test` row paired with the property row.

## Anti-criteria

- Never property-tests a function that is not pure: properties require determinism, so a function that touches disk, network or clock is unfit unless its side effects are mocked or its pure core is extracted.
- Never leaves the empty case unchecked: when shrinking returns `""`, `0` or `[]`, that is the classic "empty case missed" finding, not a cherry-picked fluke.
- Never replaces the existing bun-test examples: properties express the universal claim, and examples are sampled instances of it.

## Output format

The `## Learning` entry uses C/R/L format (the C/R/L trail; `## Changelog` is only a legacy alias, ISAFormat.md): `conjectured` = property as written, `refuted by` = shrunk counterexample, `learned` = missing case, `criterion now` = the tightened property.

### ISA `## Test Strategy` row shape

```
| isc      | anchors_to | type          | property                                    | generator                              | runs  | tool |
| ISC-N    | literal    | bun-property  | parse(write(x)) ≡ x                         | fc.constantFrom(field) × fc.stringMatching(value) | 1000  | bun test ./test/hooks/lib/isa-utils.property.test.ts -t "returns the value written" |
```

## Inputs

### Candidate shapes and the ten property categories

A pure function (no side effects, deterministic output given input) is a candidate on its own. The other shapes name the categories they usually support; a dash means no shape points there by default.

| # | Category | Form | Candidate shape | LifeOS-shaped example |
|---|----------|------|-----------------|--------------------|
| 1 | **Round-trip** | `decode(encode(x)) === x` | parser ↔ serializer pair | `parseFrontmatter(serializeFrontmatter(x)) ≡ x` |
| 2 | **Idempotency** | `f(f(x)) === f(x)` | data transform (sort, dedup, normalize) | `removeTrailingNewline(removeTrailingNewline(s)) ≡ removeTrailingNewline(s)` |
| 3 | **Commutativity** | `f(a, b) === f(b, a)` | math or accumulator | `mergeTaskLists(a, b) ≡ mergeTaskLists(b, a)` |
| 4 | **Associativity** | `f(f(a, b), c) === f(a, f(b, c))` | math or accumulator | config merge across three layers |
| 5 | **Identity** | `f(x, identity) === x` | — | `renderTemplate(t, {}) ≡ t` |
| 6 | **Conservation** | invariants preserved | collection operation (count, sum, set-membership preserved) | `iscIdsAfter(reconcile(master, eph)) ⊇ iscIdsBefore(master)` |
| 7 | **Model-based** | code matches trivial reference impl | two implementations of the same thing | `parseFrontmatter ≡ jsYaml.load + body-split` |
| 8 | **Metamorphic** | "if input grows, output should grow" | — | density-score is monotone in evidence count |
| 9 | **State-machine** | any legal sequence preserves invariants | state machine with legal-sequence invariants | ISA phase machine never goes backward except via Resume |
| 10 | **Oracle** | result matches trusted alternative | — | a classifier vs a deterministic rule table |

## Tool contract

- **Generators:** `fc.integer`, `fc.string`, `fc.array`, `fc.record`, etc.
- **Test shape:** `fc.assert(fc.property(gen, pred), { numRuns })`.
- **Run:** `bun test ./test/.../foo.property.test.ts`. The `./` prefix is required: on Bun 1.3.6 a bare relative path silently drops every child process's captured output.
- **Regression example:** a counterexample copied into an example test carries `// fc seed: 0x...` in a comment.

## Gotchas

- **fast-check shrinking is deterministic only when the seed is captured.** Pin it in a comment when a property fails: `// fc seed: 0xdeadbeef`.
- **Generator over-constraint** hides bugs (`fc.integer({min: 0, max: 100})` for code that handles all integers). Use full domain unless the function explicitly forbids inputs.
- **Generator under-constraint** produces invalid inputs and spurious failures (`fc.string()` when the function only accepts ASCII). Constrain integer ranges, string lengths and record nesting depth to the actual valid domain, no wider.
- **Shrinker convergence** — fast-check shrinks until removing any byte makes the test pass again. That output is the regression seed.

## Examples

### Integration with fast-check

```ts
import { test, expect } from "bun:test";
import * as fc from "fast-check";
import { parseFrontmatter, writeFrontmatterField } from "../../../hooks/lib/isa-utils";

// hooks/lib/isa-utils.ts exports parseFrontmatter and writeFrontmatterField (there is no serializeFrontmatter).
// The ISA frontmatter keys that carry state today are phase: and progress: (effort: and the 8-station phases are retired).
const BASE = "---\nphase: climbing\nprogress: 0/3\nslug: demo\n---\n# body\n";

test("writeFrontmatterField then parseFrontmatter returns the value written", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("phase", "progress", "slug"),
      fc.stringMatching(/^[a-z0-9][a-z0-9\/-]{0,29}$/),
      (field, value) => {
        const written = writeFrontmatterField(BASE, field, value);
        expect(parseFrontmatter(written)?.[field]).toBe(value);
      },
    ),
    { numRuns: 1000 },
  );
});
```

## References

- SKILL.md § Integration Points — Testing Doctrine Rule #12, the ISAFormat `bun-property` schema, where the Algorithm elects property depth
- fast-check documentation — <https://fast-check.dev/>
- John Hughes original QuickCheck paper — <https://www.cs.tufts.edu/~nr/cs257/archive/john-hughes/quick.pdf>
