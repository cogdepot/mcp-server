# Testing plan

**Written 2026-08-22, from one day's observed failures rather than from a
coverage report.**

The numbers look finished: 371 tests, 97.91% statements, 95.87% branches, 100%
functions, with the floor enforced in `vitest.config.ts`. That is exactly why
this plan does not propose more unit tests. On 2026-08-20 and 2026-08-22, seven
defects reached CI or later, and **not one of them was a property a unit test
could have held**. Coverage did not miss them; they live in the gaps between
where a check exists and where it runs.

---

## 1. What actually escaped, and what would have caught it

Every row is a real defect from those two days, not a hypothetical.

| # | Escaped to | Defect | Why the existing checks missed it |
|---|---|---|---|
| 1 | push gate | Go trailing newline rejected by `golangci-lint` | `lint-staged` runs on commit but its globs are `*.{ts,tsx,js,jsx,json}` - it sees no Go at all |
| 2 | push gate | Biome format error in `mcp-drift.mjs` | Same globs skip `.mjs`. The full `biome check` only runs pre-push |
| 3 | push gate | `posts.ts` not regenerated after a new source post | Nothing checks generated artifacts against their sources except a unit test that runs late |
| 4 | CI | `POST /v1/deals/{id}/dispute` uncovered by `drift.mjs` | `drift` needs network, so it is excluded from `npm test` and runs only in `verify.yml` |
| 5 | CI | Commit authored with a GitHub noreply address | `verify-authorship` exists only as a workflow; nothing local checks it |
| 6 | release gate | `smoke.mjs` pinned a 3-tool keyless set; a 4th tool failed it | `smoke` needs network and is not in `npm test`; it runs in `verify`, which runs at publish |
| 7 | release gate | `smoke.mjs` calls every required tool with no arguments; `cogdepot_get_reputation` needs a handle | Same - only surfaced when the tool was added |

**The pattern is not missing checks. It is checks that run too late.**

Six of the seven had a guard that would have caught them. The guard simply ran
at push, at CI, or at publish, rather than at the moment the mistake was made.
Defects 6 and 7 are the sharpest case: both would have **blocked the npm
publish**, because `prepublishOnly` runs `verify` which runs `smoke`. They were
found by running the release, which is the most expensive possible place.

The one genuinely uncaught case is #3, and it is the same shape: a generated
file whose source moved, with nothing asserting freshness until a test that
happens to compare them.

---

## 2. Priority 1 - move existing guards earlier

**The highest-value work in this document, and the cheapest.** No new test
logic; only relocating checks that already exist and already work.

### 2.1 A local `verify:local` that includes the networked checks

`npm test` is unit-only by deliberate design: `drift` and `smoke` reach the
network, so a developer offline would see failures unrelated to their change,
and a check that fails for unrelated reasons gets muted. That reasoning is
sound and is why `drift` was excluded in the first place.

The cost is that **the two checks most likely to fail are the two that never run
locally**. Defects 4, 6 and 7 all took that route.

Add a script that runs them when the network is available and **skips loudly**
when it is not:

```jsonc
"verify:local": "npm run typecheck && npm run test && node scripts/offline-ok.mjs drift smoke"
```

The wrapper must distinguish three outcomes, never collapsing them:

- **pass** - the check ran and held
- **skipped** - no network; print which checks did not run, exit 0
- **fail** - the check ran and found a real problem, exit non-zero

That distinction is the whole point. `drift.mjs` already models it: exit 1 means
a claim is false, exit 2 means the check could not finish, and the two are
deliberately not collapsed. `offline-ok.mjs` should preserve that.

### 2.2 Make the pre-commit hook cover what pre-push covers

Defects 1 and 2 are one defect: `lint-staged`'s file globs do not match the
files that actually broke. Go is not in the list at all, and `.mjs` is not in
the JavaScript glob.

Two options, and the second is better:

1. Widen the globs. Fragile - the next unmatched extension repeats this.
2. **Run the same command pre-commit that runs pre-push**, scoped to changed
   files. One source of truth for "is this clean", so the two can never
   disagree about what clean means.

The argument against is speed. Measure before assuming: `biome check .` covers
206 files in ~60ms, and `golangci-lint` on a changed package is seconds. A
pre-commit hook that costs two seconds and removes an entire class of failed
push is a good trade.

### 2.3 A local authorship check

Defect 5 is enforced only by a workflow. The repository goes public and history
is permanent, so a wrong identity is expensive to fix later - as it was: it
required rewriting four commits and force-pushing two shared branches.

A pre-commit check comparing `git config user.email` to the expected identity
costs nothing and fails at the only moment the fix is free.

⚠ **Also fix the workflow's fallback.** When `BASE_SHA` is unreachable - which
is what any force-push produces - `verify-authorship` scans deeper history and
reports commits from *before the rule existed*. On 2026-08-22 it flagged
`de0fc89` from 18 August, already on `main` under published tags. Rewriting that
would have broken the release tags and the npm provenance attestations. **A
guard that cannot distinguish "new violation" from "pre-existing history" will
eventually be obeyed by someone who does the destructive thing.** It should fall
back to the merge-base with `main`, or fail closed with an explicit "cannot
determine range" rather than guessing.

### 2.4 Generated-artifact freshness

Defect 3: `docs/posts/*.md` gained a file and `web/src/content/posts.ts` was not
regenerated. `posts.test.ts` catches it, but only in the web suite at push time.

Any generator whose output is committed needs a check that regenerating produces
no diff. That is one command per generator, in the same pre-commit hook:

```bash
node scripts/gen-posts.mjs && git diff --exit-code web/src/content/posts.ts
```

Applies to `gen-posts.mjs` and any future generator. Cheap, and it fails at the
commit that caused it rather than three commits later.

---

## 3. Priority 2 - close the cross-repo gaps

The recurring failure of the whole effort is **two repositories disagreeing**.
`internal/config/mcp.go` states facts about a package that ships from a
different repository on a different cadence, and no single test run sees both.

`web/scripts/mcp-drift.mjs` closes most of this by running the published package
and comparing what it finds to what the documents claim. It now covers:

- keyless tool count, against the real package
- all 20 tools classified, unknown tool fails
- prompt and resource **counts**
- no resource exposes a metered or mutating route
- every resource available without a key
- **version claims** against `dist-tags.latest`

### What is still not covered

**Prompt and resource NAMES.** The guard checks that there are five prompts, not
that they are the five the documents name. Renaming one passes.

**The spelled-out prose lists.** `MCPKeylessToolCount` guards the number four.
The sentence "one describes what cogDepot is... one explains how to obtain a
key, one previews the listings, and one reads any agent's public reputation
record" is four clauses guarded by nothing. On 2026-08-22 that sentence
hardcoded the word "Three" while the constant said four - caught only because
the count assertion happened to read the same sentence.

The fix is the one already applied to the count: render the list from a
structure rather than writing it twice. Until then, a test asserting the
sentence contains one clause per keyless tool is a cheap approximation.

**Nothing schedules `mcp-drift.mjs`.** It runs in PR checks with
`continue-on-error: true`, deliberately - it downloads a package and speaks to a
subprocess, so it fails offline, and a blocking check that fails for unrelated
reasons gets muted or removed. The consequence is that its failures are visible
but not blocking, and a red that nobody must act on is a red that gets ignored.

Worth considering: keep it non-blocking on PRs, and make it **blocking on the
release workflow only**, where the network is reliable and a false claim is
about to become public.

---

## 4. Priority 3 - the money paths

`spending.test.ts` asserts that every spending tool states its price, declares
`readOnlyHint: false`, and that the irreversible pair declares
`destructiveHint: true`. Those are the disclosure controls, and they are
well covered.

What is **not** tested is what happens when a spend goes wrong:

| Untested behaviour | Why it matters |
|---|---|
| Retry with the same `idempotency_key` does not double-charge | The only thing between an ambiguous outcome and paying twice |
| A 402 mid-negotiation leaves the 2,000-credit hold intact | A lost hold is real money in escrow |
| `close_thread` actually releases the hold | The documented escape hatch from an abandoned negotiation |
| `finalize_deal` refuses for a non-poster without charging | Poster-only since 2026-08-01; a charge on refusal would be the worst case |

These need two funded staging accounts and are only reachable through
`scripts/e2e.mjs` (`npm run e2e:staging`), which runs **by hand**. That is the
right place for them - they move real credits and cannot run on every push - but
"runs by hand" in practice means "runs when somebody remembers".

**Proposal:** make `e2e:staging` a required step of the release workflow rather
than a habit. It is the last moment before a package reaches users, the
environment is known good, and a money bug caught there costs a release rather
than a customer.

⚠ **Concurrency constraint, learned the hard way.** The e2e suite serializes
deliberately: "two concurrent Playwright runs would share the seeded staging
accounts and corrupt each other's exact money-delta assertions." Any automation
of `e2e:staging` must respect that, or it will produce failures that look like
money bugs and are not.

---

## 5. Explicitly not proposing

- **More unit tests.** 100% function coverage, 95.87% branches. Not one of the
  seven observed defects was unit-testable.
- **Mutation testing.** Attractive, but this codebase already verifies guards by
  mutation *by hand* at the moments it matters, and it caught two tautological
  assertions that way. A tool would add CI minutes for a habit already in place.
- **Property-based testing for the money math.** `money.ts` is small, its rate is
  asserted against the live document, and its tests already derive expectations
  from published figures rather than restating the constant. The risk there is
  not arithmetic; it is the ledger behaviour in §4.
- **Testing the deprecated surfaces.** Logging, sampling and roots are
  deprecated by SEP-2577 and deliberately unimplemented. A test asserting the
  logging capability is absent already exists, which is the right amount.

---

## 6. Order of work

| # | Item | Effort | Buys |
|---|---|---|---|
| 1 | `verify:local` with a loud offline skip | ~1h | defects 4, 6, 7 |
| 2 | Pre-commit parity with pre-push | ~1h | defects 1, 2 |
| 3 | Generated-artifact freshness | ~30m | defect 3 |
| 4 | Local authorship check | ~15m | defect 5 |
| 5 | Fix `verify-authorship`'s unreachable-base fallback | ~1h | prevents a destructive false positive |
| 6 | Prompt/resource names in `mcp-drift.mjs` | ~1h | a rename passing silently |
| 7 | `e2e:staging` in the release workflow | ~2h | the money paths in §4 |

Items 1 to 4 are one evening and address six of the seven observed defects.
Item 5 is small and prevents the only failure here that could have caused
real damage.

---

## 7. Accept

- A developer who commits a Go formatting error, an unmatched `.mjs` file, a
  stale generated artifact, or a wrong commit identity learns at **commit**.
- A developer who adds a tool, renames a prompt, or lets the documents drift
  from the package learns at **commit or push**, not at publish.
- `verify-authorship` never asks anyone to rewrite released history.
- The money paths in §4 run against staging before a release, not when somebody
  remembers.
- No check in this plan can pass vacuously. Every one fails closed, and
  "could not run" is reported as its own outcome rather than as success.
