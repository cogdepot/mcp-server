/**
 * Checks that the version npm actually serves is the one this repository meant
 * to ship.
 *
 *   node scripts/verify-published.mjs           # version from package.json
 *   node scripts/verify-published.mjs 0.7.0
 *
 * Everything else in this repository tests the SOURCE. This installs the
 * published tarball by name and version, the way a stranger's client does, and
 * asks it what it advertises. The gap it closes is real and has happened here
 * before in the neighbouring form: the hosted server served 0.3.0 for six days
 * while npm served 0.4.0, because nothing checked the artefact after the fact.
 *
 * A publish can succeed and still ship the wrong thing - a stale dist/ in the
 * tarball, a files list that omits a module, a build that emitted last commit's
 * output. `npm publish` reports none of that; it reports that an upload
 * happened.
 *
 * Read-only and keyless against the API: a key is set only because the keyed
 * tools are not advertised without one, and every assertion here reads a
 * tools/list response, which is built before any request leaves the process.
 *
 * Exit codes: 0 the published package is what was intended, 1 it is not, 2 the
 * check could not be completed.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const PACKAGE = "@cogdepot/mcp-server";

/** Every binding an operator may declare, in the order the API lists them. */
const EXPECTED_BINDINGS = ["JSONRPC", "HTTP+JSON", "https://cogdepot.com/bindings/webhook-v1"];

const version =
  process.argv[2] ?? JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const failures = [];
function check(ok, message) {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${message}`);
  if (!ok) failures.push(message);
}

/**
 * Starts the published package and returns its tools plus its own version.
 *
 * Raw JSON-RPC over stdio rather than the client SDK, so this keeps working if
 * the SDK is ever a devDependency only. The framing is newline-delimited JSON,
 * which is the whole of what the stdio transport needs.
 *
 * The child inherits the full environment with COGDEPOT_ stripped. A minimal
 * env does NOT work: npx on Windows needs APPDATA, TEMP and SystemRoot, and the
 * failure mode is a spawn that hangs until the timeout rather than an error
 * naming the cause. Stripping COGDEPOT_ matters for a different reason - a
 * developer with a staging base URL exported would otherwise be checking a
 * different deployment than the one this asserts.
 */
function listTools(spec) {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("COGDEPOT_")),
    );
    // The keyed tools are not advertised without a key, and two of the three
    // things asserted below live on keyed tools. Never sent anywhere: the
    // tools/list response is built before any request to the API.
    env.COGDEPOT_API_KEY = "verify-published-not-a-real-key";

    const child = spawn("npx", ["-y", spec], {
      env,
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let serverInfo;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out after 180s (stderr: ${stderr.slice(-300)})`));
    }, 180_000);

    const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          clearTimeout(timer);
          child.kill();
          reject(new Error(`non-JSON on stdout, which corrupts the stream: ${line.slice(0, 120)}`));
          return;
        }
        if (msg.id === 1) {
          serverInfo = msg.result?.serverInfo;
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        }
        if (msg.id === 2) {
          clearTimeout(timer);
          child.kill();
          if (msg.error) {
            reject(new Error(`tools/list failed: ${JSON.stringify(msg.error)}`));
            return;
          }
          resolve({ tools: msg.result?.tools ?? [], serverInfo });
          return;
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== null) {
        reject(new Error(`exited ${code} before answering (stderr: ${stderr.slice(-300)})`));
      }
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "verify-published", version: "1.0.0" },
      },
    });
  });
}

console.log(`\nverify-published: ${PACKAGE}@${version}\n`);

// npm's CDN serves a new version to `npx` a little after `npm publish` returns,
// so a first miss is expected rather than a failure. Retry a few times before
// concluding anything - the alternative is a check that fails on timing and
// gets muted, which is how a guard stops being read.
//
// Two specs, not one. Some npx builds refuse an exact `name@x.y.z` while
// resolving `name@latest` for the same tarball - observed on Windows for 0.7.0,
// where @latest and @0.6.0 both ran and @0.7.0 did not. Falling back costs
// nothing in rigour: every assertion below reads the package's OWN reported
// version, so a @latest that has moved on fails the first check rather than
// passing something else off as this release.
const SPECS = [`${PACKAGE}@${version}`, `${PACKAGE}@latest`];
let surfaces;
outer: for (let attempt = 1; attempt <= 3; attempt += 1) {
  for (const spec of SPECS) {
    try {
      surfaces = await listTools(spec);
      console.log(`  ..    resolved via ${spec}`);
      break outer;
    } catch (err) {
      console.log(`  ..    ${spec} attempt ${attempt}: ${err.message.slice(0, 70)}`);
    }
  }
  if (attempt === 3) {
    console.error(`verify-published: could not run ${PACKAGE}@${version} by any spec.`);
    console.error("Nothing was proven either way.");
    process.exit(2);
  }
  await new Promise((r) => setTimeout(r, 20_000));
}

const { tools, serverInfo } = surfaces;

// The package resolved by version could still BE a different build, and its own
// reported version is the only thing that can say so.
check(
  serverInfo?.version === version,
  `the package reports its own version as ${version} (got ${serverInfo?.version ?? "nothing"})`,
);

const profile = tools.find((t) => t.name === "cogdepot_update_profile");
if (!profile) {
  check(false, "cogdepot_update_profile is advertised");
} else {
  const props = profile.inputSchema?.properties ?? {};
  check("route_protocol_binding" in props, "cogdepot_update_profile advertises route_protocol_binding");
  check("agent_card_url" in props, "cogdepot_update_profile advertises agent_card_url");
  check(
    JSON.stringify(props.route_protocol_binding?.enum) === JSON.stringify(EXPECTED_BINDINGS),
    `the published binding enum is the three the API accepts (got ${JSON.stringify(props.route_protocol_binding?.enum ?? null)})`,
  );
  // The required list is the half a caller feels first: a field that became
  // required by accident breaks every existing caller on upgrade.
  const required = [...(profile.inputSchema?.required ?? [])].sort();
  check(
    JSON.stringify(required) === JSON.stringify(["contact_email", "contact_name", "deal_route"]),
    `the published required list is unchanged (got ${JSON.stringify(required)})`,
  );
}

const deal = tools.find((t) => t.name === "cogdepot_get_deal");
const dealText = deal?.description ?? "";
check(/counterparty_interface/.test(dealText), "cogdepot_get_deal names counterparty_interface");
check(/counterparty_agent_card_url/.test(dealText), "cogdepot_get_deal names counterparty_agent_card_url");

console.log("");
if (failures.length) {
  console.error(
    `${failures.length} thing(s) the published package does not do.\n` +
      "npm allows no free unpublish, so the remedy is a follow-up version, not a retraction.",
  );
  process.exit(1);
}
console.log(`verify-published: OK - ${PACKAGE}@${version} advertises what this repository built.`);
