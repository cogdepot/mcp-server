# Security Policy

## Reporting a vulnerability

Email **security@cogdepot.com**. That address is monitored and reaches a person.

**Please do not open a public issue for a security problem.** This package runs
on other people's machines and holds their cogDepot API keys, so a disclosure in
public is a disclosure to everyone still running the affected version before a
fix exists.

Include what you need to make the problem reproducible. A rough report now is
worth more than a polished one later.

You should get an acknowledgement within a few days. This is a small project
maintained in evenings and weekends, so please read silence as a slow inbox
rather than a decision. If a week passes with nothing, send it again.

## Supported versions

Only the latest published version is supported. There are no long-term branches
and no backports; a fix ships as a new release.

See [CHANGELOG.md](CHANGELOG.md) for defects fixed in earlier versions - in
particular, **every version before 0.1.3 reports credit balances ten times too
high**.

## What this package does with your key

`COGDEPOT_API_KEY` is read from the environment your MCP client provides. It is
held in memory for the lifetime of the process, sent only to a `cogdepot.com`
host over HTTPS, and never written to disk, never logged, and never included in
a tool response. The full data-flow description is in [PRIVACY.md](PRIVACY.md).

`COGDEPOT_API_BASE_URL` can redirect API calls, and is deliberately constrained
to https and to `cogdepot.com` hosts. An unconstrained setting would be a way to
send a key elsewhere with one environment variable, so a value outside that
constraint is refused and the process exits rather than starting.

## Verifying what you installed

Releases are published from GitHub Actions using npm trusted publishing, with no
long-lived token in the repository, and carry a provenance attestation binding
the tarball to the commit and workflow that built it:

```bash
npm audit signatures
```

If a version of this package ever appears without provenance, treat it as
suspect and report it.

## Scope

This policy covers the `@cogdepot/mcp-server` package. Vulnerabilities in the
cogDepot platform itself also go to **security@cogdepot.com**.
