import { describe, expect, it } from "vitest";

// @ts-expect-error - a .mjs script outside rootDir, with no types. Tests are
// excluded from tsconfig, so this import is resolved by vitest and never by tsc;
// importing the mechanism itself is the point, so the guard below and the tool
// that fixes a failure can never disagree about what a version carrier is.
import { findMismatches, nextVersion, readVersions, setVersion } from "../scripts/version.mjs";

import { SERVER_VERSION } from "./strings.js";

/**
 * Every place this package states its version must state the same one.
 *
 * Two releases have already been spent on this. SERVER_VERSION sat at 0.1.0
 * through 0.1.1 and 0.1.2 - the one field a client can actually see was the one
 * nothing checked. server-json.test.ts now pins that, and it is the reason this
 * file does not simply re-assert it.
 *
 * Then package-lock.json drifted the opposite way and sat at 0.3.0 through four
 * releases, because the publish workflow checks three files against the git tag
 * and the lock is not one of them. That is what this file exists for: the whole
 * carrier set, read from the same list `scripts/version.mjs` writes, so adding a
 * carrier to the tool adds it to this guard automatically.
 */

interface Carrier {
  readonly file: string;
  readonly field: string;
  readonly version: string;
}

describe("every version carrier", () => {
  it("states the same version", () => {
    const carriers = readVersions() as Carrier[];
    const mismatches = findMismatches(carriers) as Carrier[];

    // Named in the failure rather than left as "expected [] to have length 0",
    // because the useful half of this failing is which file drifted.
    expect(
      mismatches.map((carrier) => `${carrier.file} ${carrier.field}=${carrier.version}`),
    ).toEqual([]);
  });

  it("covers the four files that carry a version", () => {
    // A carrier removed from the list is a carrier nothing checks again, which
    // is exactly how package-lock.json drifted for four releases.
    const files = new Set((readVersions() as Carrier[]).map((carrier) => carrier.file));

    expect([...files].sort()).toEqual([
      "package-lock.json",
      "package.json",
      "server.json",
      "src/strings.ts",
    ]);
  });

  it("agrees with the SERVER_VERSION the module actually exports", () => {
    // readVersions() reads strings.ts as text. This asserts the parse matches
    // the evaluated export, so a refactor that moves the declaration cannot
    // leave the guard reading a string the module no longer uses.
    const carriers = readVersions() as Carrier[];
    const parsed = carriers.find((carrier) => carrier.field === "SERVER_VERSION");

    expect(parsed?.version).toBe(SERVER_VERSION);
  });
});

describe("the bump arithmetic", () => {
  it.each([
    ["patch", "0.7.1", "0.7.2"],
    ["minor", "0.7.1", "0.8.0"],
    ["major", "0.7.1", "1.0.0"],
    ["minor", "1.9.9", "1.10.0"],
    ["patch", "0.9.9", "0.9.10"],
  ])("resolves %s from %s to %s", (release, from, expected) => {
    expect(nextVersion(from, release)).toBe(expected);
  });

  it("passes an explicit x.y.z through unchanged", () => {
    expect(nextVersion("0.7.1", "2.0.0")).toBe("2.0.0");
  });

  it.each(["v1.2.3", "1.2", "1.2.3-rc.1", "1.2.3+build", "latest", "01.2.3", ""])(
    "refuses %o, which is neither a release type nor an x.y.z version",
    (request) => {
      // Prerelease and build metadata are refused rather than passed through:
      // the MCP registry takes plain x.y.z, and a tag the registry rejects is
      // discovered after npm has already published.
      expect(() => nextVersion("0.7.1", request)).toThrow();
    },
  );
});

describe("the bump write", () => {
  it("refuses a version that is not x.y.z, before touching any file", () => {
    expect(() => setVersion("not-a-version", { dryRun: true })).toThrow();
  });

  it("reports a change for every carrier without writing under --dry-run", () => {
    const before = readVersions() as Carrier[];

    const changes = setVersion("9.9.9", { dryRun: true }) as {
      file: string;
      before: string;
      after: string;
    }[];

    expect(changes).toHaveLength(before.length);
    expect(changes.every((change) => change.after === "9.9.9")).toBe(true);
    // The files on disk are untouched, which is the whole contract of a dry run.
    expect(readVersions()).toEqual(before);
  });
});
