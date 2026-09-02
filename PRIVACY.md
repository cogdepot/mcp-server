# Privacy Policy - cogDepot MCP server

Last updated: 2026-09-02

This policy covers the `@cogdepot/mcp-server` package: the MCP server you run on
your own machine. The cogDepot platform it talks to is governed separately by the
policy at <https://cogdepot.com/privacy>.

## What this software is

`@cogdepot/mcp-server` runs locally, as a process started by your MCP client. It
is not a hosted service. Nothing in this package receives your data on our
infrastructure except through the ordinary cogDepot API calls described below.

## What it collects

**Nothing about you.** This package has no analytics, no telemetry, no crash
reporting and no logging to any remote destination. It opens no network
connection other than the ones listed in the next section.

Every request it makes does identify the software itself, in a `User-Agent`
header - see [Software identification](#software-identification) below. That
header names this package and its version. It is not an identifier for you, your
account or your installation, and it does not change between users or between
runs.

## What it sends, and where

| Destination | When | What |
|---|---|---|
| `https://api.cogdepot.com/.well-known/cogdepot.json` | on the first tool call and at most once every five minutes after | The `User-Agent` below, and nothing else. No credentials are attached. This is a public document, fetched so prices and terms quoted to you are current rather than baked into the package |
| `https://api.cogdepot.com/v1/*` | only when you invoke a tool that requires an account | Your API key in the `x-api-key` header, the `User-Agent` below, plus exactly the arguments you supplied to that tool |
| `https://cogdepot.com/api/preview` | only when you invoke `cogdepot_preview_listings` | The `User-Agent` below, and nothing else. **No API key is attached, deliberately**, even when one is configured - this is the public shop window, and sending the key would tell cogDepot which account is browsing it. The endpoint is rate limited by IP address, which cogDepot sees as it does for any web request |

No other host is ever contacted. The preview address is read from the discovery
document rather than hard-coded, so that it can move without stranding installed
copies; it is accepted only if it is an `https` **cogdepot.com** host, and the
tool refuses to call it otherwise rather than falling back to a built-in URL.

**One configurable exception.** Setting `COGDEPOT_API_BASE_URL` points both of
the above at a different deployment, so that this package can be tested against
a non-production environment. It is constrained to **https** and to hosts under
**cogdepot.com**; anything else is refused and the process exits rather than
starting. That constraint exists precisely because this process attaches your
API key to every request, so an unrestricted setting would be a way to send it
somewhere else.

## Software identification

Every outbound request carries a `User-Agent` header naming this package and its
version:

| Where it runs | `User-Agent` |
|---|---|
| the package on your own machine | `cogdepot-mcp/0.7.1` |
| the hosted server at `mcp.cogdepot.com` | `cogdepot-mcp-remote/0.7.1` |
| either, under continuous integration (`CI` is set) | the same, with ` (ci)` appended |

The version is the package version, so it changes with each release.

**Why it exists.** cogDepot's own storefront renders pages server-side, and those
requests carried the same default `User-Agent` this package did - Node's `node`.
Server-side traffic measurement therefore could not separate MCP tool calls from
ordinary page rendering. This header makes that separation possible.

**What it is not.** It is not an identifier. It is the same string for every user
of a given release, it does not change between runs, it contains no account
identifier, no machine identifier, no key and no user data, and it cannot be used
to link two requests to the same install. The ` (ci)` marker reflects only the
presence of the `CI` environment variable, which build systems set.

The hosted server sends its own `User-Agent` and never forwards the one your MCP
client sent to it; your client's identity does not travel onward to the API.

## Your API key

`COGDEPOT_API_KEY` is read from the environment your MCP client provides. It is
held in memory for the lifetime of the process, sent only to a `cogdepot.com` host
over HTTPS, and never written to disk, never logged, and never included in a
tool response. Error messages report that a key is missing or rejected; they do
not echo the key itself.

If no key is set, the server still runs and answers the keyless tools - the two
discovery tools and the listing preview. Tools that need an account are not
advertised at all, rather than offered and then failing.

## Remote OAuth mode

The remote HTTP server (`npm run serve:remote`) can run behind per-user OAuth
instead of a shared static-header key. It is enabled on the deployment by
`COGDEPOT_OAUTH_ISSUER`, `COGDEPOT_OAUTH_CLIENT_ID` and `COGDEPOT_OAUTH_RESOURCE`
(with optional `COGDEPOT_OAUTH_SCOPES`); unset, none of this applies and the
stdio server ignores these variables entirely.

In this mode the credential is the user's own Cognito **access token**, presented
as `Authorization: Bearer`. The server verifies the token's signature and issuer
against the configured user pool, then relays that same token to the `cogdepot.com`
host - it is not exchanged for a key and, like the API key, is held only in memory
for the request, never written to disk, never logged, and never returned in a tool
response. A token that fails verification is refused with a `401`; a request with
no token is served the keyless tools. No token is sent anywhere other than the
`cogdepot.com` host the base URL already constrains.

## Retention

This package retains nothing between runs. It writes no files, no cache and no
state directory, and everything it holds is discarded when the process exits.

The only thing held in memory is the public discovery document, normally for
five minutes. One exception, stated precisely because "at most five minutes"
would not be true: if a refresh fails, the previously fetched copy is kept and
served past that window rather than falling back to the older copy bundled with
the package, and responses built from it say so. It is public pricing data
containing nothing about you, and it is still gone when the process exits.

Data you send to cogDepot through it is retained under the cogDepot platform
policy at <https://cogdepot.com/privacy>. Note in particular that deal records
are purged seven days after a deal is revealed, leaving only aggregate
reputation.

## Third parties

There are none. No data is shared with, sold to, or processed by any third
party. The package's runtime dependencies are the official Model Context
Protocol SDK and the Zod schema library; neither makes network calls of its own.

## Children

cogDepot is a business-to-business service and is not directed at children.

## Changes

Material changes to this policy will be published in this file, with the date
above updated, and noted in the release that carries them.

## Contact

`akashy@cogdepot.com`
