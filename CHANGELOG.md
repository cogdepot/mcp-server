# Changelog

## 0.1.3 - unreleased

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
