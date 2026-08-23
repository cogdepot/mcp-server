/**
 * Runs the networked guards locally, and reports THREE outcomes rather than two.
 *
 * `drift` and `smoke` are deliberately outside `npm test`: they reach the
 * network, so a developer offline would see failures unrelated to their change,
 * and a check that fails for unrelated reasons gets muted or deleted. That
 * reasoning is sound. The cost is that the two checks most likely to fail were
 * the two that never ran locally, and on 2026-08-20 and 2026-08-22 three defects
 * took exactly that route:
 *
 *   - an API endpoint no tool covered, found in CI
 *   - smoke's keyless tool set pinned at three when a fourth shipped
 *   - smoke calling every tool with no arguments, when one needs a handle
 *
 * The last two would have BLOCKED THE NPM PUBLISH, because `prepublishOnly`
 * runs `verify` which runs `smoke`. They were found by running the release,
 * which is the most expensive place available.
 *
 * So: run them when the network is there, skip loudly when it is not. The three
 * outcomes are never collapsed, which is the same rule drift.mjs follows for
 * itself - exit 1 means a claim is false, exit 2 means the check could not
 * finish, and conflating them produces a red that people learn to re-run
 * without reading.
 *
 *   pass    - the check ran and held
 *   skipped - no network; names what did not run, exits 0
 *   fail    - the check ran and found something real; exits non-zero
 *
 * Usage: node scripts/offline-ok.mjs drift smoke
 */

import { spawnSync } from "node:child_process";

/** Reachability probe. HEAD against the host the guards actually use. */
async function online() {
  try {
    const res = await fetch("https://api.cogdepot.com/health", {
      method: "HEAD",
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("offline-ok: name at least one npm script to run");
  process.exit(1);
}

if (!(await online())) {
  console.log("");
  console.log(`offline-ok: SKIPPED ${targets.join(", ")} - cogDepot is unreachable.`);
  console.log("offline-ok: these guards compare this package to the LIVE API, so offline");
  console.log("offline-ok: they can prove nothing either way. Nothing was checked, and");
  console.log("offline-ok: nothing is claimed. CI will run them.");
  console.log("");
  process.exit(0);
}

const failed = [];
for (const target of targets) {
  console.log(`\noffline-ok: running ${target}`);
  const run = spawnSync("npm", ["run", target], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  // Exit 2 is drift's "could not check". Treat it the way the CI workflow does:
  // a warning, not a failure. A guard that blames your code for somebody else's
  // deploy is one people stop reading.
  if (run.status === 2) {
    console.log(`offline-ok: ${target} could not complete - warning, not a failure.`);
    continue;
  }
  if (run.status !== 0) failed.push(target);
}

if (failed.length > 0) {
  console.error("");
  console.error(`offline-ok: FAILED - ${failed.join(", ")}`);
  console.error("offline-ok: this is a real finding, not a network problem. Fix it before pushing.");
  process.exit(1);
}

console.log("\noffline-ok: all networked guards held.");
