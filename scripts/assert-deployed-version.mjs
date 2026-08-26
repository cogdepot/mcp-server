/**
 * Fails unless the deployed server answers with the version it was just given.
 *
 *   node scripts/assert-deployed-version.mjs https://mcp.cogdepot.com 0.5.0
 *
 * Run by deploy.yml immediately after `cloudformation deploy` returns. That
 * command returning success means CloudFormation applied the change set, which
 * is not the same claim as "the running server is now this build" - the whole
 * failure this repository is closing is a deployment that everybody believed
 * had happened.
 *
 * Retries, because the assertion races real propagation: a function update
 * settles in seconds but not instantly, and API Gateway can serve one more
 * request from the old build. A single immediate check would flake, and a
 * flaky release gate is one people learn to re-run without reading.
 */

import { deployedVersion } from "./deployed-version.mjs";

const ATTEMPTS = 6;
const DELAY_MS = 10000;

const [url, expected] = process.argv.slice(2);

if (!url || !expected) {
  console.error("usage: assert-deployed-version.mjs <url> <expected-version>");
  process.exit(2);
}

let seen = null;

for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
  seen = await deployedVersion(url);

  if (seen === expected) {
    console.log(`deploy: OK - ${url} answers with ${seen}`);
    process.exit(0);
  }

  const reason = seen === null ? "unreachable" : `answered ${seen}`;
  console.log(`deploy: attempt ${attempt}/${ATTEMPTS} - ${url} ${reason}, want ${expected}`);

  if (attempt < ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
}

console.error("");
console.error(`deploy: ${url} never answered with ${expected}.`);
console.error(
  seen === null
    ? "It could not be reached at all. The stack updated but the endpoint is not serving."
    : `It is still serving ${seen}. The stack updated but the running build did not change.`,
);
console.error("Do NOT treat this release as deployed. The published package is ahead of the");
console.error("hosted server, which is exactly the drift this check exists to catch.");
process.exit(1);
