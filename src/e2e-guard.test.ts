import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Guards on the guards in scripts/e2e.mjs.
 *
 * That script is the only thing in this repository that spends real money and
 * seals a real deal. Everything else either mocks the transport or refuses to
 * call a tool that spends. Its refusals are therefore the highest-consequence
 * lines here, and the failure mode is silent: a script that stopped refusing
 * production would not error, it would succeed, and the cost would be two
 * strangers introduced to each other and money gone.
 *
 * These run the real script, because a test that only read the source could not
 * tell a working guard from a commented-out one.
 */

/** Runs the script and returns what it printed and whether it refused. */
function run(env: Record<string, string>): { output: string; refused: boolean } {
  try {
    const stdout = execFileSync(process.execPath, ["scripts/e2e.mjs"], {
      env: { PATH: process.env.PATH ?? "", ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { output: stdout, refused: false };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return { output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`, refused: true };
  }
}

const FULLY_ARMED = {
  COGDEPOT_E2E_POSTER_KEY: "poster-key",
  COGDEPOT_E2E_NEGOTIATOR_KEY: "negotiator-key",
  COGDEPOT_E2E_CONFIRM: "spend",
};

// Every test in this block spawns a real `node scripts/e2e.mjs`, and vitest's
// default budget is 5s per test. That is ample in isolation - the file runs in
// under a second on its own - but not inside a loaded full-suite run, where the
// FIRST spawn also pays module-resolution cold start. On 2026-08-23 that is
// exactly what happened: the first case timed out at 5021ms while its sibling,
// spawning the same script one line later, passed in 191ms.
//
// A flaky guard is worse than a slow one. These assert the refusals on the only
// script here that spends real money, and a check that goes red for reasons
// unrelated to your change is one people learn to re-run without reading it.
describe("the end-to-end script refuses to spend where it should not", { timeout: 30_000 }, () => {
  it.each(["https://api.cogdepot.com", "https://cogdepot.com"])(
    "refuses production (%s) even with keys and confirmation set",
    (baseUrl) => {
      // Everything else is armed: this isolates the production check itself,
      // rather than passing because some other precondition was missing.
      const { output, refused } = run({ ...FULLY_ARMED, COGDEPOT_API_BASE_URL: baseUrl });

      expect(refused).toBe(true);
      expect(output).toMatch(/refusing to run against production/i);
    },
  );

  it("refuses when no deployment is named, rather than defaulting to one", () => {
    const { output, refused } = run(FULLY_ARMED);

    expect(refused).toBe(true);
    expect(output).toMatch(/COGDEPOT_API_BASE_URL is not set/i);
  });

  it("refuses without explicit confirmation, and states the cost first", () => {
    const { output, refused } = run({
      COGDEPOT_API_BASE_URL: "https://staging.api.cogdepot.com",
      COGDEPOT_E2E_POSTER_KEY: "poster-key",
      COGDEPOT_E2E_NEGOTIATOR_KEY: "negotiator-key",
    });

    expect(refused).toBe(true);
    expect(output).toMatch(/\$2\.10/);
    expect(output).toMatch(/COGDEPOT_E2E_CONFIRM=spend/);
  });

  it("refuses one key used for both sides", () => {
    const { output, refused } = run({
      ...FULLY_ARMED,
      COGDEPOT_E2E_POSTER_KEY: "same",
      COGDEPOT_E2E_NEGOTIATOR_KEY: "same",
      COGDEPOT_API_BASE_URL: "https://staging.api.cogdepot.com",
    });

    expect(refused).toBe(true);
    expect(output).toMatch(/identical/i);
  });
});

describe("the end-to-end script is not wired into anything automatic", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };

  it.each(["verify", "prepublishOnly", "test", "coverage", "smoke"])(
    "%s does not invoke it",
    (script) => {
      // A push must never seal a deal. `verify` runs on every change and
      // `prepublishOnly` runs on every release, so the moment e2e appears in
      // either, CI starts spending money on somebody's behalf.
      expect(pkg.scripts[script] ?? "").not.toMatch(/e2e/);
    },
  );

  it("is available as its own script, so it is triggered deliberately", () => {
    expect(pkg.scripts["e2e"]).toMatch(/e2e\.mjs/);
  });
});
