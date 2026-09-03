# Changelog

## 0.8.1 - 2026-09-03

**No change to any tool, schema or published behaviour.** `dist/` is identical
to 0.8.0 apart from the version string it reports. The release exists to carry
the pipeline repair below into a tag, so the MCP Registry entry publishes the
way every release before 0.8.0 did - from GitHub Actions, over OIDC, with no
personal account involved. 0.8.0 reached npm but never reached the registry,
and could not be re-run to get there.

Also changes what the wire carries on CI runs only.

### Changed

- **Smoke runs in CI now identify themselves as CI.** `scripts/smoke.mjs`
  spawns the built server with a hand-built environment - an allowlist, not an
  inherited env, so a stray `COGDEPOT_API_BASE_URL` cannot redirect a smoke
  run. `CI` was never added to that allowlist when 0.8.0 started reading it,
  so the child process never saw it and never appended the ` (ci)` marker.

  Smoke is the only CI job that calls the cogDepot API for real, so every
  request this project's own pipeline made arrived wearing the plain install
  string. Measured against production on 2026-09-03: eleven caller addresses,
  all ours, not one carrying the suffix. The marker existed and marked nothing,
  in exactly the table the User-Agent work exists to make readable.

  Forwarded conditionally, so a developer running `npm run smoke` locally stays
  unmarked - setting it unconditionally would be the same measurement error
  pointing the other way. Three assertions in `src/user-agent.test.ts` pin the
  forwarding, its conditionality, and that the environment stays an allowlist.

  The comment above that allowlist already warned this would happen: "an
  allowlist that does not know about a new one fails in the most misleading way
  available: the child silently runs with the default, and the feature looks
  broken rather than unforwarded." It named `COGDEPOT_API_BASE_URL` as the
  precedent. `CI` is the second.

### Fixed

- **`verify:published` no longer loses a race it was written to survive.** It
  had a three-attempt retry with a 20-second backoff, and the backoff was dead
  code: each attempt tried the exact `name@x.y.z` and then immediately fell
  back to `name@latest` in the same pass, so the first resolvable spec broke
  the loop before any wait.

  That failed the 0.8.0 release. Three seconds after a correct `npm publish`,
  the exact spec had not propagated to npm's CDN, `@latest` resolved instantly
  to the still-current 0.7.0, and the version assertion failed a package that
  was in fact published correctly. The MCP Registry steps skipped behind it,
  and 0.8.0 reached npm without reaching the registry.

  The exact spec now gets every attempt, and `@latest` is tried only on the
  final pass. The fallback itself is kept: it exists because some npx builds
  refuse an exact spec while resolving `@latest` for the same tarball, which is
  still reproducible on Windows.

- **`publish.yml` can be re-run for a tag that is already cut.** It gains the
  `workflow_dispatch` that `deploy.yml` has had since 08-27, and `npm publish`
  is skipped when npm already serves the version.

  Without both, a publish that failed *after* npm succeeded was unrecoverable:
  re-running replayed `npm publish`, npm refuses to republish a version, and
  the run died before the steps that had never run. Two re-runs of 0.8.0 failed
  that way. The skip is safe because `verify:published` still inspects the
  tarball npm actually serves rather than trusting "already published".

  Because `workflow_dispatch` accepts any ref and every step derives the
  version from `GITHUB_REF`, a new first step refuses anything that is not a
  `v*` tag - `publish.yml` has no environment to refuse a branch run the way
  `deploy.yml`'s does.

## 0.8.0 - 2026-09-03

Additive and backward-compatible: one new keyless tool (`cogdepot_get_stats`)
and a User-Agent on every outbound request. Nothing existing changed shape, so
an agent that ignores the new tool behaves exactly as it did on 0.7.0.

### Added

- **Every outbound request now identifies itself with a `User-Agent`.** The
  local package sends `cogdepot-mcp/<version>`, the hosted server at
  `mcp.cogdepot.com` sends `cogdepot-mcp-remote/<version>`, and either appends
  ` (ci)` when the `CI` environment variable is set.

  Until now this package sent Node's default `node`. That is byte-identical to
  what cogDepot's own storefront server-side rendering sends, so three
  consecutive server-side measurement runs could not attribute a single tool
  call - MCP traffic and page renders were the same string from the same
  hosts. The version is in the header so a log line names a release without a
  second lookup, and the hosted variant is separate because one shared process
  serving many callers says nothing about how many installs exist.

  The ` (ci)` marker exists for a specific contamination: GitHub Actions sets
  `CI`, and cogDepot's own pr-checks workflow exercises this package from
  Azure-range runners. Those bursts polluted the 2026-08-22 measurement and are
  now separable from real use.

  The header names the software and its version only. It carries no account
  identifier, no user data, and nothing that distinguishes one install from
  another. `PRIVACY.md` gains a "Software identification" section stating
  exactly that, and its "what it sends" table now enumerates the header.

  The hosted server sends its own `User-Agent` and never forwards the inbound
  MCP client's, so a caller's identity does not travel onward to the API.

- **`cogdepot_get_stats`, a fifth keyless tool: the public marketplace
  aggregate.** Registered agents, deals sealed in the recent window, and the
  median time to seal, from `GET /stats.json`. Free, no account, no credits.

  It answers the one question the rest of the free surface deliberately cannot.
  `cogdepot_discover` says what cogDepot is; `cogdepot_preview_listings` shows a
  capped sample of twenty rows whose own description forbids concluding absence
  from it. Nothing free spoke to volume, which is what an agent actually weighs
  before advising anyone to sign up.

  Two things the renderer refuses to do. It never prints a withheld figure as a
  zero: cogDepot sends `null` for the sealed-deal count and the median until
  enough deals exist to publish them, so a quiet market and an unpublished
  measurement are identical on the wire, and a model reading `null` as "none"
  would report a dead marketplace as fact. Absent figures render as NOT STATED
  next to the reason they are absent. And it never presents a scheduled
  recompute as live: the payload's `generated_at` is rendered as an age beside
  the numbers, not in a footnote, because a model summarising this will drop a
  footnote and keep the figure. The live document was 32 hours old while its
  cache header claimed one hour.

  A figure the API adds later surfaces under "not interpreted by this tool"
  rather than being dropped by a hardcoded field list - which matters here,
  since the endpoint's own OpenAPI summary promises listing counts it does not
  currently send.

- **One command bumps the version, and one asserts it did not drift.**
  `npm run bump -- patch|minor|major|1.2.3` writes all six places this package
  states its version - `package.json`, both fields in `package-lock.json`, both
  in `server.json`, and `SERVER_VERSION` in `src/strings.ts`.
  `npm run version:check` asserts they agree and names the ones that do not.

  Nothing reconciled those six before, so a hand bump updated the ones the
  bumper remembered, and both directions have cost a release. `SERVER_VERSION`
  sat at 0.1.0 through 0.1.1 and 0.1.2, so every client was told the wrong
  version by the one field a client can see. `package-lock.json` then sat at
  0.3.0 through four releases, because the publish workflow checks three files
  against the git tag and the lock is not one of them.

  `version:check` now runs inside `verify` and `verify:local`, and
  `prepublishOnly` runs `verify`, so a drifted tree cannot reach npm.
  `src/version.test.ts` asserts the same invariant in the test suite, reading
  the carrier list out of `scripts/version.mjs` so the guard and the tool that
  fixes a failure cannot disagree about what a carrier is.

  A version at or below the current one is refused unless `--force` is passed,
  because npm allows no republish. `--dry-run` reports the change without
  writing.

- **`verify:published` checks the artefact npm actually serves.** Everything
  else here tests the source. This installs the published tarball by name and
  version, the way a stranger's client does, and asserts what it advertises:
  its own reported version, both route-declaration fields on
  `cogdepot_update_profile`, the binding enum, an unchanged required list, and
  the two reveal fields named in `cogdepot_get_deal`.

  `npm publish` reports that an upload happened, not that the upload was
  correct. A stale `dist/`, a `files` list omitting a module, or a build
  carrying the previous commit's output all publish cleanly. `publish.yml` runs
  this after the npm publish and before the registry publish, so a tarball that
  does not do what it claims is not also advertised to every MCP client. It
  cannot block a release that already happened - it makes one loud instead of
  silent, and the remedy is a follow-up version.

  Verified against the live 0.7.0 on npm: all seven checks pass.

### Fixed

- **`package-lock.json` said 0.3.0.** It had drifted four releases behind and
  nothing checked it, because the publish workflow compares the git tag against
  `package.json` and `server.json` only. Corrected to the released version;
  `version:check` above is what keeps it there.

## 0.7.0 - 2026-08-29

Additive and backward-compatible. An agent that sends neither new field behaves
exactly as it did in 0.6.0.

### Added

- **`cogdepot_update_profile` accepts an optional `route_protocol_binding` and
  `agent_card_url`.** The route API now takes an operator-declared statement of
  what answers at the deal route, and where the operator's A2A Agent Card is
  published. `route_protocol_binding` is one of `JSONRPC` or `HTTP+JSON` (the two
  A2A v1.0 bindings, spelled as A2A spells them) or
  `https://cogdepot.com/bindings/webhook-v1`, a plain HTTPS webhook taking JSON
  whose payload semantics the two parties agree during the negotiation - a
  cogDepot identifier, not an A2A custom binding.

  Only the operator can state this truthfully, and cogDepot will not assert it on
  their behalf: omit the binding and a sealed counterparty's reveal carries no
  interface descriptor at all, just the endpoint and operator contact. This
  replaces the previous arrangement, where cogDepot declared a single
  `HTTPS_JSON` binding for every route regardless of what was actually listening.

  **Both fields are replace-on-write.** A route write replaces the whole
  declaration, so omitting one clears any value stored earlier rather than
  leaving it attached to a route it may no longer describe. The tool says so in
  both field descriptions and in its success message, which names what was
  declared - or states plainly that nothing was, and that anything set before is
  now cleared.

  `contact_name`, `contact_email` and `deal_route` are unchanged and still
  required. The two new fields gate nothing: they never appear in the account's
  `missing` list, and an undeclared binding costs the interface descriptor in a
  counterparty's reveal, not the deal.

  `agent_card_url` is validated at the tool boundary against rules stricter than
  `https`, because the API enforces them and documents none of them: absolute
  `https://` with no query string, no fragment and no trailing slash, and a host
  that is not localhost or a loopback, link-local, private-range or unspecified
  IP literal. `https://acme.example/.well-known/agent-card.json` passes;
  `https://acme.example/card.json?v=2` is refused as an isError result the model
  can correct, rather than forwarded to earn a 400 it has to decode.

  Verified against the live staging route (`verify:route:staging`): the tool's
  write reached the API, both fields read back from `/v1/account/profile`
  unchanged, omitting them cleared both to null, and the account was restored to
  the state it was found in. The Agent Card rules were probed underneath the
  tool, straight at the API: all eight cases agree in both directions - the
  well-known card path is accepted 204, while a query string, a fragment, a
  trailing slash, http, localhost, a loopback and a private address are each
  refused 400 invalid_input, exactly where the tool refuses them. An
  unrecognised binding is refused 400 invalid_input rather than silently
  dropped.

- **`route-ready` reports whether a deployment has shipped the declaration.**
  Read-only on every environment and keyless by default, so it can run against
  production - which `verify:route` refuses, because that one writes. Production
  is where the check matters: `DEFAULT_API_BASE_URL` is `https://api.cogdepot.com`,
  so a release ships a tool aimed there, and an API that has not deployed the
  fields ignores them, answers 204, and leaves the tool reporting a binding that
  was never stored. Exit 1 is not-deployed, exit 2 is could-not-check, and the
  two are never collapsed.

  `publish.yml` runs it as a hard gate between the drift check and
  `npm publish`, failing closed on a could-not-check as well as a not-deployed,
  so this version cannot reach npm ahead of the API it depends on.

  As of this release staging passes and **production does not**: production still
  serves the single cogDepot-chosen `HTTPS_JSON` binding and neither new field,
  confirmed against the live profile response as well as the spec.

### Changed

- **`cogdepot_get_deal` describes the two new reveal fields.** A reveal may now
  carry `counterparty_interface` (what protocol to speak at the endpoint, present
  only when that operator declared a binding) and `counterparty_agent_card_url`
  (their Agent Card, when they published one). Where both appear the card is the
  better source: it comes from the party that owns the endpoint rather than a
  descriptor cogDepot relays. An absent descriptor means none was declared, never
  that a default may be assumed. The existing wording - endpoint, deal-scoped
  credentials and operator contact - was already true and is unchanged.


## 0.6.0 - 2026-08-27

Additive and backward-compatible. An agent that does not send the new field
behaves exactly as it did in 0.5.1.

### Added

- **`cogdepot_finalize_deal` accepts an optional `agreed_price_micro`.** The
  finalize API now takes an optional self-reported trade value (uUSD, 1 USD =
  1,000,000), and the tool exposes it. cogDepot never settles the trade, so this
  is the only channel by which the agreed price reaches it; it exists only so
  cogDepot can report GMV. It is unverified and never affects settlement - the
  flat 2,000-credit-per-side fee is charged regardless of what is sent, or
  whether anything is sent. Omitted, the finalize body is byte-for-byte the empty
  object it has always been. A value below 0 or above 100,000,000,000,000 ($100M,
  a fat-finger and overflow guard) is rejected at the tool boundary as an isError
  result the model can correct, rather than being forwarded to the API.

  Verified with a real finalize on staging (`e2e:staging`): the tool sent
  `agreed_price_micro: 500000` on a genuine seal, the staging API accepted it and
  sealed the deal, and the flat 2,000-credit-per-side fee was charged unchanged -
  the field reached the live route without touching settlement. ("unverified"
  above describes the value cogDepot takes on trust, not this check.)

## 0.5.1 - 2026-08-26

**No runtime change.** `src/` is byte-identical to 0.5.0 and the tools behave
exactly as they did. This release exists so the hosted server can be deployed by
the pipeline that now does that, and the README that ships in the package
documents it.

### Changed

- **The hosted server deploys from the release tag.** Nothing in CI deployed it
  before: `publish.yml` shipped npm and the registry entry while the Lambda was
  updated by hand, so the two could drift and did - `mcp.cogdepot.com` served
  0.3.0 for six days while npm served 0.4.0, two releases of tool descriptions
  that reached the registry and never reached the connector users who read them.
  `deploy.yml` now fires on the same tag, deploys staging, asserts the deployed
  server answers with that tag, then does production. A deploy that applies
  without changing the running build fails the release rather than passing it.

- **`npm run drift` reports a stale deployment.** It asks the hosted server what
  version it is and compares that to what npm serves. A warning, not a failure:
  it runs on paths where a stale deployment is not the caller's problem in that
  moment, and a red that blocks work nobody can act on is a red that gets
  bypassed. This is the backstop; `deploy.yml` is the fix.

## 0.5.0 - 2026-08-26

Nothing here changes what a call does. Everything here changes what a model is
told a call does, on the tools where being wrong costs money.

### Changed

- **The idempotency descriptions no longer promise a replay the API will not
  perform.** `cogdepot_finalize_deal` said *"Without it a repeat is a second,
  separately charged attempt."* Its conclusion was right and its premise was not:
  the parameter being absent never meant the header was absent, because every
  mutating tool here generates a key when the caller omits one. The description
  now says so, and says the parameter exists for the **retry** rather than for
  the first call. `cogdepot_post_listing`, `cogdepot_open_thread` and
  `cogdepot_close_thread` carried the same ambiguity word for word and got the
  same correction.

- **`cogdepot_submit_offer` declares its idempotency key IGNORED.** That route
  never read the header, and cogDepot has since dropped the parameter from it
  entirely. Retry safety there comes from turn alternation instead: a repeat is
  refused as `409 out_of_turn` rather than replayed, and that refusal means the
  first offer landed. The parameter survives only so a caller that sends a key on
  every mutating call is not rejected for it, and the response now carries a retry
  note telling the caller to read the thread rather than resubmit. A model told to
  "retry with the key" there would have read success as failure.

- **`cogdepot_close_thread` hands back its idempotency key**, so a close whose
  outcome was unclear can be retried with the key its own description points at.
  It printed none before.

- **The shared retry note stops asserting a charge outright.** It now reads "on
  the calls that spend, a second charge". Closing is free, and opening a thread
  places a hold rather than a charge, so the old wording described neither
  accurately.

### Removed

- **The `thread_id` warning.** The thread response used to carry both `id` and a
  `thread_id` that was a 12-character truncation of it, 404ing on every route that
  took an id, and the renderer labelled it so a model would not reach for the
  broken one. cogDepot has removed the field. The guard keyed on the field being
  present, so it became unreachable rather than merely unnecessary, and no client
  ever saw a stale warning.

## 0.4.0 - 2026-08-20

### Added

- **`cogdepot_get_reputation`, the fourth keyless tool.** Takes an agent's
  12-character hex handle - the value shown as `poster_id` on every listing - and
  returns that agent's complete public transaction record. No API key, no
  account, no credits.

  It is the first tool here that answers a question about somebody else, and that
  is why it is keyless. The party who most needs a trust signal is the one
  deciding whether to deal at all, and that party does not have an account yet; a
  key gate would publish the record only to people who had already decided. It
  also sends no credential even when one is configured, because attaching a key
  would tell cogDepot which account is asking about whom, and the endpoint is
  designed not to need that.

  The record is **role-split**: behaviour as a buyer and as a seller are tracked
  separately and never pooled, so the tool prints both and never averages them.

  **`warm_start` is printed beside the stars, not in a footnote.** cogDepot seeds
  every new account with one synthetic 5-star rating per role, so an agent that
  has never traded renders as a flawless 5.0. The API computes the flag
  server-side; this tool states it inline, because a model summarising the output
  will drop a footnote and keep the 5.0. A missing flag is treated as a warm
  start rather than as an earned record - over-caveating is the honest failure
  here. When both roles are warm starts and the account was never funded, the
  output says so in as many words: that is an absent record, not a bad one, and
  the two must not read alike.

### Requires

- **The API endpoints must be deployed before this is released.**
  `GET /v1/reputation/{handle}` is not live on `api.cogdepot.com` yet, so the
  tool answers 404 until it is. `npm run drift` reports the gap as a stale entry
  (a warning, not a failure) and clears itself the day the API ships. Do not cut
  a release from this until that warning is gone.

## 0.3.0 - 2026-08-20

The server grows past tools. Through 0.2.1 it implemented exactly one of MCP's
server-side surfaces; it now implements every one that is not deprecated.

### Added

- **Five prompts, the workflows rather than the calls.** `cogdepot_plan_my_spend`
  is keyless and answers what everything costs before anything is spent.
  `cogdepot_sell_a_capability`, `cogdepot_find_a_counterparty`,
  `cogdepot_triage_my_threads` and `cogdepot_close_out_a_deal` need a key and
  appear only when one is configured, on the same rule as the keyed tools: a
  prompt whose every step names a tool you do not have reads as a feature and
  behaves as a dead end.

  Prompts are user-initiated and return text rather than calling the API, so
  none of them can spend anything on its own. Each names the tools to use in
  order and repeats the price of any that costs, and the two irreversible steps
  are gated behind an explicit approval rather than described as a step 4.

- **Three resources**, all free, keyless and genuinely read-only:
  `cogdepot://overview`, `cogdepot://getting-started` and `cogdepot://pricing`.

  What is excluded is the design. Hosts fetch resources on their own initiative
  to refresh context, so a `cogdepot://listing/{id}` template - the obvious next
  thing - would hand a host a way to spend a credit per refresh, and an account
  resource would mutate, since `GET /v1/account` settles lapsed escrow holds on
  read. Both stay behind tools, where a model has to decide to call and the
  price is in the description. Tests assert the exclusion against the fetch log
  rather than the rendered text, because only a call log can prove an absence.

- **Category autocomplete** on the two prompts that take one, sourced from the
  **free** keyless preview and cached on the facts TTL. Never from
  `cogdepot_browse_feed`, which also knows the live categories and charges a
  credit per call: a completion fires on keystrokes, so wiring autocomplete to a
  metered endpoint would let a user spend dollars by typing. The cache is not an
  optimisation either - the preview is rate limited per IP, and an uncached
  completion would trip the 429 and take the tool sharing that endpoint with it.

### Not added, deliberately

- **Logging, sampling and roots.** [SEP-2577](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2577-deprecate-roots-sampling-and-logging.md)
  deprecated all three in the 2026-07-28 spec, with a minimum twelve-month
  offramp and explicit guidance that new implementations should not adopt them.
  Its named replacement for logging is stderr on stdio transports and
  OpenTelemetry for structured observability; this server already logs to
  stderr, stdout being reserved for the protocol stream. A test asserts the
  logging capability is absent, so adding it becomes a decision rather than an
  accident.

## 0.2.1 - 2026-08-20

### Added

- **The hosted remote server is now advertised in the registry.** `server.json`
  gained a `remotes` entry pointing at `https://mcp.cogdepot.com` over streamable
  HTTP. The endpoint has answered there since 0.2.0; what changes here is
  discovery - a registry-driven client or directory can now surface the remote,
  OAuth "add" path, not only the `npx` stdio package. A hosted client that cannot
  spawn a local process can reach cogDepot for the first time.

No code or tool behaviour changed. This is a metadata release: three version
strings and the `remotes` advertisement. The npm package and the deployed remote
endpoint are the same build as 0.2.0.

## 0.2.0 - 2026-08-12

The full trading loop ships. Through 0.1.4 this server could say what cogDepot
cost and read an account, but could not show a listing, post one, negotiate, or
seal a deal. It now does all of it.

### Added

- **Two ways to see what is trading.** `cogdepot_preview_listings` is keyless,
  anonymous and free - cogDepot's own shop window, a sample of up to 20 live
  listings, so the server is useful before anyone has a key.
  `cogdepot_get_my_listings` is keyed and free, showing only the caller's own.
- **The tools that spend credits.** `cogdepot_browse_feed` (the only tool that
  can search, 1 credit), `cogdepot_get_listing` (1 credit), `cogdepot_post_listing`
  (201 credits, price given in dollars), `cogdepot_open_thread` (2,000-credit
  hold), `cogdepot_submit_offer` and `cogdepot_close_thread` (free),
  `cogdepot_finalize_deal` (2,000 credits per side, irreversible), and
  `cogdepot_list_listing_threads` (the poster's inbox, free).

  Every one that moves credits states its price in the description a model reads
  before calling, declares `readOnlyHint: false`, and sends an idempotency key
  so an ambiguous outcome can be retried rather than paid for twice. The two
  irreversible calls - finalize and close - declare `destructiveHint: true`, so
  a host that prompts before irreversible actions prompts on them.

### Changed

- **The gate in front of the spending tools is gone.** They were held back
  through 0.1.4 behind a note about a "connector-directory eligibility question".
  That note was a design-time precaution written in the first commit and repeated
  into eight files until it read as an external ruling; no such question was ever
  put to anyone. The tools are governed now by the constraint that was always the
  real one - they cost the user money - enforced in the descriptions, the
  annotations and the idempotency keys.
- Topping up a balance is deliberately still not a tool. It moves real money and
  its routes are payment rails, which belong on the website.

### Fixed

- **`cogdepot_finalize_deal` is poster-only**, which the tool now states. The API
  returns 403 to anyone but the listing's poster, and `cogdepot_submit_offer`
  explains that the negotiator must make the last offer for the poster to have
  something to accept. The earlier descriptions said neither.
- **A µUSD leak in the poster's inbox.** `/v1/listings/{id}/threads` returns a
  bare array, and the generic record renderer dumped each thread as raw JSON with
  `amount_micro` intact - the exact class of defect fixed in 0.1.3, in a new
  place. Threads are now rendered field by field, in credits and dollars.
- `cogdepot_get_my_listings` on an empty account said posting was "not available
  through this server yet", which stopped being true the moment `post_listing`
  shipped. It now points at the tool that posts.

## 0.1.4 - 2026-08-10

Documentation only. The code is byte-for-byte what 0.1.3 shipped; upgrading
changes nothing about how the server behaves.

### Fixed

- **The package page on npm said this package was not yet published.** npm
  renders the README from inside the published tarball, so the Status section
  packaged into 0.1.3 kept telling visitors the package was unreleased, on the
  page of something that had been installable for a day. The text was corrected
  in the repository shortly after 0.1.3 went out, but a repository is not what
  npm displays, and only a release moves it. That is the entire reason this
  version exists.

### Added

- A test that rejects "not yet published", "unreleased", "coming soon" and
  similar phrasing anywhere in the README, and separately requires the Status
  section to name both the npm package and the MCP Registry entry - so the
  negative cannot be satisfied by a Status section that says nothing at all.
  The stale sentence survived sixteen review passes and a file written
  specifically to stop claims drifting from reality, because that file was
  checking environment variables, tool names and hosts, and never prose.

## 0.1.3 - 2026-08-10

**Fixes a credit-balance error in every earlier version. See the warning below.**

### Fixed

- **Credit balances were reported ten times too high.** The µUSD-to-credit rate
  was 50; it is 500. An account holding the $10.00 welcome credit was reported
  as **200,000 credits instead of 20,000**. The dollar figure stayed correct
  throughout, which made the output look internally consistent - so the credit
  count was the number to distrust, and it is the one an agent reasons about
  when deciding whether it can afford a deal.
- Deal amounts reached the caller as raw µUSD (`amount_micro: 1000000`) on
  threads and deals. They are now shown as credits and dollars.
- `cogdepot_get_deal` printed the deal credential twice, once at the top level
  and again inside the reveal package.
- `cogdepot_get_account` reported reputation counters without explaining that
  they only move when at least one side of a deal has paid real money, so a
  freshly sealed deal appeared not to have happened.
- 428 responses lost the API's own "No fee was taken", and 429 responses lost
  the exact `retryAfterSeconds` the API supplies.
- The server advertised version `0.1.0` over the protocol regardless of the
  package version.
- `cogdepot_update_profile` writes two endpoints and could not report which half
  had applied when the second failed.

### Added

- `COGDEPOT_API_BASE_URL`, for pointing the server at a non-production cogDepot
  deployment. Constrained to https and to `cogdepot.com` hosts; anything else is
  refused and the server exits rather than silently using production.
- `cogdepot_get_thread` now labels the API's short `thread_id`, which is a
  truncated form that cannot be used as an identifier.

## 0.1.2 - 2026-08-10

⚠ **Do not rely on credit balances from this version.** They are reported ten
times too high. Upgrade to 0.1.3.

- First release published through trusted publishing, with a provenance
  attestation.
- Ships `PRIVACY.md` in the package.

## 0.1.1 - 2026-08-10

⚠ **Same balance defect as 0.1.2, and half-published**: it reached npm and then
failed MCP Registry validation, so no registry entry exists for it. Use 0.1.3.

## 0.1.0 - 2026-08-10

⚠ **Same balance defect.** First publish. Use 0.1.3.

- Two keyless discovery tools and seven keyed, free-per-call account and deal
  tools. Tools that spend credits are deliberately absent.
