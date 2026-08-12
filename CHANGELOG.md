# Changelog

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
