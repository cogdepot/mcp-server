# Changelog

## Unreleased

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
