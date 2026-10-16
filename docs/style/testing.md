# Testing

Apply this guide after [development.md](development.md).

## Behavior first

Test the flows users care about, not how the code is split. Cover what's
essential, not every line. `npm test` runs `node --test 'test/*.test.mjs'`,
so only top-level test files run and nothing under `test/fixtures/` does.
`test/<id>.test.mjs` covers a challenge package's hooks, servers, and
extensions, and `test/verify.test.mjs` covers `tools/verify.mjs`. Tests
exercise the real entry point, such as `tools/verify.mjs`, against fixture
repositories.

| Tier | Proves | Lives in |
| --- | --- | --- |
| Flow | A command works end to end on a fixture repo | `test/*.test.mjs` |
| Unit | Pure logic handles its inputs | `test/*.test.mjs` |

- **Flow tests script the run like a user:** run the real command against a
  fixture root in place (`--root`) and assert on its exit status and output.
  Copy the fixture to a temporary directory only when the command writes.
- **Unit tests cover only pure logic,** such as package discovery and id
  checks, with no mocking. When many inputs matter, drive them from a table of
  input and expected output. Don't unit test wiring.
- **Tests make no model calls and need no credentials.** The only network a
  test may use is the npm registry, and only to run a package's `install`
  hook; everything else stays offline.
- **Fixtures live in `test/fixtures/`.** A fixture is a small repo layout with
  one challenge package per top-level directory; a fixture's Markdown is test
  data, not documentation.
- **`test/fixtures/canary.test.mjs` throws if executed.** It proves the test
  glob skips fixtures; keep fixture files out of top-level `test/*.test.mjs`.
- **A test's path mirrors the file or flow it covers.**

## What a change needs

- **Every fix comes with a test that fails without it.** Revert the fix and
  watch it go red before trusting it.
- **A new or changed command or rule updates its flow test.**

## What to fake

- **Don't mock your own code.** Fake only painful edges you don't own: remote
  services, models, and time.
- **Fakes implement the real interface** and record what they were asked, so
  tests assert on requests, not implementation details.
- **Control the clock for durations;** never wait in a test.
- **Build test data with factories:** a function with a default for every
  field, so a call names only what the test is about.

## How a test reads

- **DRY the plumbing, DAMP the story.** Extract builders and assertion
  helpers; keep the triggering input and asserted value inline, so each test
  reads top to bottom on its own.
- **Four phases:** setup, exercise, verify, teardown, separated by blank
  lines. One exercise per test.
- **Name the behavior,** in plain words, with no requirement ID.
- **Skip with a guard and a reason** as the test's first line, so the reason
  shows in the report.
