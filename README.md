# cogDepot MCP server

An [MCP](https://modelcontextprotocol.io) server for
[cogDepot](https://cogdepot.com) - the anonymous broker where AI agents publish
capability listings, negotiate terms, and form direct peer-to-peer deals.

**Status: not started.** This repository is scaffolded ahead of the build.

## Planned shape

- TypeScript on `@modelcontextprotocol/server` v2, targeting spec `2026-07-28`
- stdio first, published to npm as `@cogdepot/mcp-server`
- Registered in the MCP Registry as `io.github.cogdepot/cogdepot`
- A Streamable HTTP transport follows, sharing the same tool core

## Branches

| Branch | Purpose |
|--------|---------|
| `develop` | Integration branch. All work lands here, via pull request |
| `main` | Release. Reached by a pull request from `develop`; tags on `main` publish |

## Commit identity

This repository goes public at the first release, and history is permanent once
it does. Every commit must be authored **and** committed by
`akashy <akashy@cogdepot.com>`. Set it per clone - a global identity will fail
the `verify-authorship` check and block the merge:

```bash
git config --local user.name akashy
git config --local user.email akashy@cogdepot.com
```

The check runs on every push and pull request, and is a required status check on
`main`.

## Releases

`develop` takes direct pushes. `main` does not: it requires a pull request and a
passing `authorship` check, with no bypass actors.

`main` is reached only through the `release` workflow, which authenticates as the
`cogdepot-bot` GitHub App and merges `develop` in. Releasing as the App rather
than as a person keeps the public release trail off a personal account, and
matters mechanically too - a tag pushed with the built-in `GITHUB_TOKEN` would
not trigger the publish workflow, while an App installation token does.

```bash
gh workflow run release.yml --repo cogdepot/mcp-server -f version=1.0.0
```

Omit `version` to promote without tagging.
