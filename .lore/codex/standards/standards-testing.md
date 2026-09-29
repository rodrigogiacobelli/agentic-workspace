---
id: standards-testing
title: Testing standard
summary: What earns a test in this project and what does not — the default of
  no test, the four properties that justify one, the categories that are never
  tested, and the marking convention for tests needing a compositor, a real
  pseudoterminal or a real repository.
related:
  - standards-code
  - 003-source-markdown-is-canonical
---

# Testing standard

The default is **no test**. A test is added when it earns its place, and the
burden of proof sits with the test.

This inverts the usual default deliberately. An agent writing code produces
tests faster than it produces judgment about which ones are worth keeping, and
a suite padded with tests that cannot fail costs more to read, run and maintain
than the defects it catches.

## What earns a test

All four properties hold, or the test is not written:

1. **The logic is decidable in isolation** — it takes values and returns
   values, with no compositor, no network, no real process.
2. **Being wrong is silent.** The defect corrupts data, or produces a plausible
   wrong answer, rather than raising an error the user sees.
3. **The input space is wide enough that reasoning does not cover it** —
   nesting, precedence, boundaries, escaping, or a table of cases.
4. **The test would have caught a defect a careful reader misses.**

In this project that describes a small, specific set:

| Area | Why it qualifies |
|---|---|
| Markdown block byte-range splicing | Silent file corruption, wide input space, pure function (`003-source-markdown-is-canonical`) |
| Ignore-pattern matching | Nested ignore files, negation and precedence; a wrong answer silently hides or shows a file |
| Path resolution — asset links, relative paths, workspace roots | A plausible wrong path is indistinguishable from a right one |
| Theme scope-to-tag translation | A table with precedence rules and a documented fallback |
| Terminal escape-sequence parsing | Wide input space, and malformed output corrupts the display silently |

## What is not tested

- **The framework.** Tauri's command dispatch, the editor library's own
  behaviour, the git library's own behaviour.
- **Plumbing.** A command that forwards its arguments to one function and
  returns the result. A getter. A constructor.
- **UI wiring.** That a click calls a handler, that a component renders a prop.
- **Anything that only passes because it mocks the code under test.** A test
  asserting that a mock was called is a test of the mock.
- **One test per branch of the same behaviour.** One test covers a behaviour;
  a table of cases covers its inputs.

## Tests that touch the machine

A test needing a compositor, a real pseudoterminal, a real repository or real
hardware is marked `#[ignore]` and run deliberately by name. `cargo test --lib`
stays runnable with no desktop session, no shell and no fixtures.

Diagnostic tests — ones that print what the machine reports rather than
asserting an outcome — are also `#[ignore]`d. They exist for failures that are
otherwise silent, and they are not assertions.

## How the tests run

Rust tests run with `cargo test --lib` in `src-tauri/`.

Frontend tests are `*.test.ts` files beside the module they test, under
`src/`. `pnpm test` runs every one with Node's own test runner, `node --test`;
Node 22.18 and later run TypeScript by stripping its types, with no flag, so
the project has no frontend test dependency. A module under test is one Node can load: plain `.ts` with no JSX,
no `@tauri-apps/*` import and no browser object touched at module level. A test
names the file it imports with its `.ts` extension. `pnpm typecheck` leaves the
test files out (`tsconfig.json`), since the project installs no type
declarations for Node's modules.

## Rules

- **Test at the level the defect lives at.** A splice bug is a unit test, not
  an end-to-end one.
- **Production code carries no test-only abstraction.** No interface exists
  solely so a test can substitute an implementation.
- **A test names the behaviour, not the function.** `splices_only_the_edited_block`,
  not `test_splice`.
- **A deleted test needs no justification beyond the fact that it asserted
  nothing.** Removing such a test is an improvement.
