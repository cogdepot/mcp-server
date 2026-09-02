/**
 * The version mechanism.
 *
 * This package states its version in six places across four files. They are not
 * redundant - each is read by something different: npm reads package.json, the
 * MCP registry reads server.json, an MCP client reads SERVER_VERSION over the
 * protocol in `serverInfo`, and `npm ci` reads package-lock.json. Nothing
 * reconciles them, so a hand bump updates the ones the bumper remembers.
 *
 * That is not hypothetical. SERVER_VERSION sat at 0.1.0 through the 0.1.1 and
 * 0.1.2 releases while the other three agreed, so every client was told the
 * wrong version by the one field a client can actually see. A test now pins
 * that. package-lock.json then drifted the other way and sat at 0.3.0 through
 * four releases, because no check covered it at all.
 *
 * So: one command sets all six, and one command asserts all six agree. The
 * assertion is the load-bearing half - it runs in the test suite and in
 * `verify`, which `prepublishOnly` runs, so a drifted tree cannot reach npm.
 *
 * Usage:
 *
 *   node scripts/version.mjs                 report every carrier and its value
 *   node scripts/version.mjs check           same, but exit 1 if they disagree
 *   node scripts/version.mjs patch           bump the patch component and write
 *   node scripts/version.mjs minor|major     likewise
 *   node scripts/version.mjs 1.2.3           set an explicit version
 *   node scripts/version.mjs patch --dry-run show what would change, write nothing
 *
 * Exit codes follow the same rule drift.mjs uses, because collapsing them
 * produces a red that people learn to re-run without reading:
 *
 *   0  the carriers agree, or the write succeeded
 *   1  a claim is false - the carriers disagree, or a bump was refused
 *   2  the check could not finish - a file is missing or unparseable
 *
 * Deliberately offline. It bumps relative to package.json rather than asking
 * npm what is published: a release is cut from the tree, and a script that
 * needs the network to tell you the version cannot run in the places this one
 * has to. `npm view @cogdepot/mcp-server version` remains the way to ask what
 * is live, and the release checklist in README.md says to do that first.
 *
 * Deliberately NOT `npm version`. That command knows only package.json, and it
 * commits and tags as a side effect - which would put a tag on the tree before
 * the CHANGELOG entry and the other three files were written.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Strict semver-without-prerelease. npm and the MCP registry both take this. */
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const RELEASE_TYPES = ["major", "minor", "patch"];

/**
 * Every place the version is stated, and how to read and write it.
 *
 * The JSON carriers round-trip byte-identically through
 * `JSON.stringify(value, null, 2) + "\n"`, which is asserted below before any
 * write - so a bump touches the version line and nothing else. That matters
 * most for package-lock.json, where `"version":` appears 182 times and a
 * textual replace would be a lottery.
 */
const CARRIERS = [
  { file: "package.json", field: "version", kind: "json", path: ["version"] },
  { file: "package-lock.json", field: "version", kind: "json", path: ["version"] },
  {
    file: "package-lock.json",
    field: 'packages[""].version',
    kind: "json",
    path: ["packages", "", "version"],
  },
  { file: "server.json", field: "version", kind: "json", path: ["version"] },
  {
    file: "server.json",
    field: "packages[0].version",
    kind: "json",
    path: ["packages", "0", "version"],
  },
  { file: "src/strings.ts", field: "SERVER_VERSION", kind: "ts" },
];

/** The SERVER_VERSION declaration, captured so a write preserves its shape. */
const SERVER_VERSION_PATTERN = /(export const SERVER_VERSION = ")([^"]*)(";)/;

class VersionError extends Error {
  constructor(message) {
    super(message);
    this.name = "VersionError";
  }
}

function readFile(file) {
  try {
    return readFileSync(join(ROOT, file), "utf8");
  } catch (error) {
    throw new VersionError(`cannot read ${file}: ${error.message}`);
  }
}

function readJson(file) {
  const raw = readFile(file);
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new VersionError(`cannot parse ${file}: ${error.message}`);
  }
  return { raw, value };
}

function atPath(value, path, file, field) {
  let cursor = value;
  for (const key of path) {
    if (cursor === null || typeof cursor !== "object" || !(key in cursor)) {
      throw new VersionError(`${file} has no ${field}`);
    }
    cursor = cursor[key];
  }
  if (typeof cursor !== "string") {
    throw new VersionError(`${file} ${field} is not a string`);
  }
  return cursor;
}

function setAtPath(value, path, next) {
  let cursor = value;
  for (const key of path.slice(0, -1)) cursor = cursor[key];
  cursor[path[path.length - 1]] = next;
}

/** Every carrier and the version it currently states. */
export function readVersions() {
  return CARRIERS.map((carrier) => {
    if (carrier.kind === "json") {
      const { value } = readJson(carrier.file);
      return { ...carrier, version: atPath(value, carrier.path, carrier.file, carrier.field) };
    }
    const match = SERVER_VERSION_PATTERN.exec(readFile(carrier.file));
    if (!match) throw new VersionError(`${carrier.file} has no ${carrier.field} declaration`);
    return { ...carrier, version: match[2] };
  });
}

/** The version package.json states. The one every other carrier must match. */
export function currentVersion() {
  return atPath(readJson("package.json").value, ["version"], "package.json", "version");
}

/** Carriers that disagree with package.json. Empty means the tree is consistent. */
export function findMismatches(versions = readVersions()) {
  const expected = versions[0].version;
  return versions.filter((carrier) => carrier.version !== expected);
}

/** `major`/`minor`/`patch` applied to `from`, or an explicit version validated. */
export function nextVersion(from, request) {
  if (VERSION_PATTERN.test(request)) return request;
  if (!RELEASE_TYPES.includes(request)) {
    throw new VersionError(
      `"${request}" is neither a release type (${RELEASE_TYPES.join(", ")}) nor an ` +
        "x.y.z version. Prerelease and build metadata are not supported: the MCP " +
        "registry takes plain x.y.z, and this package has never shipped anything else.",
    );
  }
  const [major, minor, patch] = from.split(".").map(Number);
  if (request === "major") return `${major + 1}.0.0`;
  if (request === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** True when `a` is strictly greater than `b`, comparing numerically per field. */
function isAfter(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i];
  }
  return false;
}

/**
 * Writes `next` to every carrier. Returns what changed.
 *
 * Carriers are grouped by file and each file is read once, mutated for all of
 * its carriers, and written once. Doing it per carrier instead is a
 * read-modify-write clobber: package-lock.json holds two carriers, and the
 * second write - built from the copy read before the first was applied - drops
 * the first. That bug shipped into this script's first draft and was caught
 * only because `check` was run immediately after the bump, which is the reason
 * the two halves belong in one tool.
 *
 * Each JSON file is re-serialised whole, so this asserts the round trip is
 * lossless before trusting it - a formatting change smuggled into a version
 * bump would be invisible in review and enormous in the lock file.
 */
export function setVersion(next, { dryRun = false } = {}) {
  if (!VERSION_PATTERN.test(next)) {
    throw new VersionError(`"${next}" is not an x.y.z version`);
  }

  const changes = [];
  const writes = [];
  const files = [...new Set(CARRIERS.map((carrier) => carrier.file))];

  for (const file of files) {
    const carriers = CARRIERS.filter((carrier) => carrier.file === file);

    if (carriers[0].kind === "json") {
      const { raw, value } = readJson(file);
      // Line endings are the working tree's business, not this script's. Git's
      // autocrlf hands a Windows checkout CRLF while JSON.stringify always emits
      // LF, so comparing and writing without this rewrites every line of the
      // lock file - or, with the guard below, refuses to run at all on Windows.
      const eol = raw.includes("\r\n") ? "\r\n" : "\n";
      const serialise = (json) => (JSON.stringify(json, null, 2) + "\n").replace(/\n/g, eol);
      if (serialise(value) !== raw) {
        throw new VersionError(
          `${file} does not round-trip through JSON.stringify unchanged, so ` +
            "rewriting it would reformat the file. Refusing to write. Reformat the " +
            "file to two-space JSON with a trailing newline, or bump it by hand.",
        );
      }
      for (const carrier of carriers) {
        const before = atPath(value, carrier.path, file, carrier.field);
        setAtPath(value, carrier.path, next);
        changes.push({ ...carrier, before, after: next });
      }
      writes.push([file, serialise(value)]);
      continue;
    }

    const raw = readFile(file);
    const match = SERVER_VERSION_PATTERN.exec(raw);
    if (!match) throw new VersionError(`${file} has no ${carriers[0].field} declaration`);
    writes.push([file, raw.replace(SERVER_VERSION_PATTERN, `$1${next}$3`)]);
    changes.push({ ...carriers[0], before: match[2], after: next });
  }

  // Written only after every carrier has been read and rewritten in memory, so
  // a failure on the last file does not leave the first three bumped.
  if (!dryRun) {
    for (const [file, contents] of writes) writeFileSync(join(ROOT, file), contents);
  }

  return changes;
}

function pad(values) {
  return Math.max(...values.map((value) => value.length));
}

function report(versions) {
  const width = pad(versions.map((carrier) => `${carrier.file} ${carrier.field}`));
  for (const carrier of versions) {
    console.log(`  ${`${carrier.file} ${carrier.field}`.padEnd(width)}  ${carrier.version}`);
  }
}

function main(argv) {
  const dryRun = argv.includes("--dry-run");
  const force = argv.includes("--force");
  const positional = argv.filter((arg) => !arg.startsWith("-"));
  const request = positional[0];

  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      [
        "Usage:",
        "  npm run version:check              assert every carrier agrees",
        "  npm run bump -- patch              bump patch and write all carriers",
        "  npm run bump -- minor|major",
        "  npm run bump -- 1.2.3              set an explicit version",
        "  npm run bump -- patch --dry-run    show the change, write nothing",
        "  npm run bump -- 1.2.3 --force      allow a version at or below the current one",
        "",
        "Ask npm what is already published before bumping:",
        "  npm view @cogdepot/mcp-server version",
      ].join("\n"),
    );
    return 0;
  }

  if (request === undefined || request === "check") {
    const versions = readVersions();
    const mismatches = findMismatches(versions);
    if (mismatches.length === 0) {
      console.log(`version ${versions[0].version}, stated consistently in ${versions.length} places:`);
      report(versions);
      return 0;
    }
    console.error(`version carriers disagree. package.json says ${versions[0].version}:`);
    report(versions);
    console.error("");
    console.error(`Fix: npm run bump -- ${versions[0].version}`);
    return 1;
  }

  const current = currentVersion();
  const next = nextVersion(current, request);

  if (next === current) {
    // Not an error when the tree is merely inconsistent: re-setting the current
    // version is exactly how a drifted carrier gets corrected.
    const mismatches = findMismatches();
    if (mismatches.length === 0) {
      console.error(`already at ${current}, and every carrier agrees. Nothing to do.`);
      return 1;
    }
    console.log(`re-stating ${current} across ${mismatches.length} drifted carrier(s).`);
  } else if (!isAfter(next, current) && !force) {
    console.error(
      `refusing to go from ${current} to ${next}. npm cannot republish or reuse a ` +
        "version, so a tree numbered below what is already released can never be " +
        "published. Pass --force if this is deliberate - reverting an unreleased " +
        "bump is the one good reason.",
    );
    return 1;
  }

  const changes = setVersion(next, { dryRun });
  const width = pad(changes.map((change) => `${change.file} ${change.field}`));
  console.log(dryRun ? `would set ${next}:` : `set ${next}:`);
  for (const change of changes) {
    const label = `${change.file} ${change.field}`.padEnd(width);
    const note = change.before === change.after ? "unchanged" : `${change.before} -> ${change.after}`;
    console.log(`  ${label}  ${note}`);
  }

  if (!dryRun) {
    console.log("");
    console.log("Still to do by hand, because no script should guess at them:");
    console.log("  1. add the CHANGELOG.md entry for this version");
    console.log("  2. update PRIVACY.md if what the package transmits changed");
    console.log("  3. npm run verify:local");
  }

  return 0;
}

// Only when run directly, so the test suite can import the helpers above.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    if (error instanceof VersionError) {
      console.error(`version: ${error.message}`);
      process.exit(2);
    }
    throw error;
  }
}
