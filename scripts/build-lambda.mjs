/**
 * Bundles the remote MCP server into a single CommonJS file for AWS Lambda.
 *
 * One self-contained file under lambda-dist/, plus a package.json that marks the
 * artifact CommonJS so nodejs20.x loads index.js as CJS regardless of this repo's
 * own "type": "module". CJS rather than ESM deliberately: the bundle carries no
 * top-level await (verified), so CJS sidesteps the ESM-Lambda handler-loading
 * footguns entirely. The SAM template's CodeUri points here; `aws cloudformation
 * package` zips it as-is (no BuildMethod, so nothing rebuilds it at deploy time).
 */

import { build } from "esbuild";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const OUT = "lambda-dist";

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

await build({
  entryPoints: ["src/lambda.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: `${OUT}/index.js`,
  // The AWS SDK is on the Lambda image, but this server does not import it; jose
  // and the MCP SDK are bundled because they are not.
  logLevel: "info",
});

writeFileSync(`${OUT}/package.json`, `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`);
process.stdout.write(`built ${OUT}/index.js\n`);
