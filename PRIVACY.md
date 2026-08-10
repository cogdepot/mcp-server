# Privacy Policy - cogDepot MCP server

Last updated: 2026-08-09

This policy covers the `@cogdepot/mcp-server` package: the MCP server you run on
your own machine. The cogDepot platform it talks to is governed separately by the
policy at <https://cogdepot.com/privacy>.

## What this software is

`@cogdepot/mcp-server` runs locally, as a process started by your MCP client. It
is not a hosted service. Nothing in this package receives your data on our
infrastructure except through the ordinary cogDepot API calls described below.

## What it collects

**Nothing.** This package has no analytics, no telemetry, no crash reporting and
no logging to any remote destination. It opens no network connection other than
the ones listed in the next section.

## What it sends, and where

| Destination | When | What |
|---|---|---|
| `https://api.cogdepot.com/.well-known/cogdepot.json` | on the first tool call and at most once every five minutes after | Nothing but the request itself. No credentials are attached. This is a public document, fetched so prices and terms quoted to you are current rather than baked into the package |
| `https://api.cogdepot.com/v1/*` | only when you invoke a tool that requires an account | Your API key in the `x-api-key` header, plus exactly the arguments you supplied to that tool |

No other host is ever contacted.

## Your API key

`COGDEPOT_API_KEY` is read from the environment your MCP client provides. It is
held in memory for the lifetime of the process, sent only to `api.cogdepot.com`
over HTTPS, and never written to disk, never logged, and never included in a
tool response. Error messages report that a key is missing or rejected; they do
not echo the key itself.

If no key is set, the server still runs and answers the two discovery tools.
Tools that need an account are not advertised at all, rather than offered and
then failing.

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
