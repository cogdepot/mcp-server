/**
 * Runs a command with cogDepot keys fetched from SSM Parameter Store.
 *
 *   node scripts/with-keys.mjs staging smoke
 *   node scripts/with-keys.mjs staging e2e
 *   node scripts/with-keys.mjs prod smoke
 *
 * Exists so a key is never pasted into a shell, written into this repository, or
 * left in shell history. Nothing here prints a parameter value, and the fetched
 * values are passed to the child process and then dropped with it.
 *
 * Parameters live under /cogdepot/{env}/mcp, the convention the API's own SSM
 * tree already uses, but the exact names are NOT mechanical - they are declared
 * per environment below, because the two deployments diverge. Production's smoke
 * key is the review account that was provisioned before this server existed
 * (review_account_api_key), not a second account created for the test; staging's
 * is a plain api_key. A shared "{prefix}/api_key" rule cannot express that, and
 * pretending it can is how the wrong parameter gets read.
 *
 * Nothing in this file writes to SSM. Creating the parameters is a deliberate
 * act performed once, by a person, with the key in front of them - see the
 * README. This only reads.
 */

import { execFileSync, spawnSync } from "node:child_process";

// Each environment declares, per command, the exact parameter name to read and
// the variable it becomes. Fully spelled out rather than assembled from a
// prefix, so a divergence like production's review account is visible here
// rather than hidden in string concatenation.
const ENVIRONMENTS = {
  staging: {
    baseUrl: "https://staging.api.cogdepot.com",
    // The e2e seals a real deal, so it is offered on staging only. The script
    // itself refuses production independently; this is the outer of two gates.
    allowsE2e: true,
    params: {
      smoke: { "/cogdepot/staging/mcp/api_key": "COGDEPOT_API_KEY" },
      // Writes to the account this key owns, so it is offered on staging only.
      // verify-route.mjs refuses production independently; this is the outer of
      // the two gates, the same arrangement e2e already has.
      "verify:route": { "/cogdepot/staging/mcp/api_key": "COGDEPOT_API_KEY" },
      e2e: {
        "/cogdepot/staging/mcp/e2e_poster_key": "COGDEPOT_E2E_POSTER_KEY",
        "/cogdepot/staging/mcp/e2e_negotiator_key": "COGDEPOT_E2E_NEGOTIATOR_KEY",
      },
    },
  },
  prod: {
    baseUrl: "https://api.cogdepot.com",
    allowsE2e: false,
    params: {
      // The production MCP account provisioned before this server was built -
      // the directory review account - rather than a second account registered
      // just to run this. review_account_api_key and review_account_id are the
      // pre-existing pair under /cogdepot/production/mcp.
      smoke: { "/cogdepot/production/mcp/review_account_api_key": "COGDEPOT_API_KEY" },
    },
  },
};

const [envName, command] = process.argv.slice(2);

function die(message) {
  console.error(`with-keys: ${message}`);
  process.exit(1);
}

const environment = ENVIRONMENTS[envName];
if (!environment) {
  die(`unknown environment "${envName ?? ""}". Expected one of: ${Object.keys(ENVIRONMENTS).join(", ")}`);
}
// Refuse e2e against a deployment that does not allow it BEFORE reporting the
// command as unknown, so the safety message is the one a caller sees.
if (command === "e2e" && !environment.allowsE2e) {
  die(
    `refusing to run e2e against ${envName}.\n` +
      "It seals a real deal between two accounts and permanently reveals each to the other.",
  );
}
const required = environment.params[command];
if (!required) {
  die(
    `"${command ?? ""}" is not defined for ${envName}. ` +
      `Expected one of: ${Object.keys(environment.params).join(", ")}`,
  );
}

/**
 * Reads one SecureString.
 *
 * stdio is captured rather than inherited so a value cannot reach the terminal
 * through the AWS CLI's own output, and the error path deliberately reports the
 * parameter NAME and never the command's stdout.
 */
function readParameter(name) {
  try {
    const raw = execFileSync(
      "aws",
      ["ssm", "get-parameter", "--name", name, "--with-decryption", "--query", "Parameter.Value", "--output", "text"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const value = raw.trim();
    if (!value) die(`${name} exists but is empty`);
    return value;
  } catch {
    die(
      `could not read ${name}.\n` +
        "Either it does not exist, or this AWS identity cannot decrypt it.\n" +
        "Create it with the aws ssm put-parameter command in the README, in the account that owns the deployment.",
    );
  }
}

const env = {
  ...process.env,
  COGDEPOT_API_BASE_URL: environment.baseUrl,
  ...(command === "e2e" ? { COGDEPOT_E2E_CONFIRM: "spend" } : {}),
};

for (const [name, variable] of Object.entries(required)) {
  env[variable] = readParameter(name);
}

console.log(
  `with-keys: ${Object.keys(required).length} parameter(s) loaded, ` +
    `running "${command}" against ${environment.baseUrl}`,
);

// shell:true is required on Windows, where npm is a .cmd shim that Node refuses
// to spawn directly (the CVE-2024-27980 mitigation). It costs nothing here: the
// keys travel in `env`, never in argv, so no value reaches the command line, the
// shell's parser, or its history. Only the literal string "run <command>" does.
const result = spawnSync("npm", ["run", command], { env, stdio: "inherit", shell: true });

if (result.error) {
  // Without this a failure to launch was indistinguishable from a child that
  // ran and printed nothing, which is exactly how this went unnoticed the first
  // time: the parameters loaded, the banner printed, and nothing else happened.
  die(`could not run "npm run ${command}": ${result.error.message}`);
}
process.exit(result.status ?? 1);
