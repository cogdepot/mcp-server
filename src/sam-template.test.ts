import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  OAUTH_AUTHORIZATION_SERVER_PATH,
  OAUTH_AUTHORIZE_PATH,
  OAUTH_PROTECTED_RESOURCE_PATH,
  OAUTH_TOKEN_PATH,
} from "./strings.js";

/**
 * Ties the SAM template's OAuth throttle buckets to the paths this server serves.
 *
 * The four sign-in routes have their own route keys and RouteSettings so a
 * flood on the MCP catch-all cannot 429 an operator's sign-in (cogDepot
 * api-check M1). Nothing else checks that wiring: `sam validate` sees a valid
 * template whether or not its paths match the handler, and a renamed path
 * constant would leave the throttled route on a path nothing calls while the
 * real one rode the catch-all again. A RouteSettings key with no matching route
 * fails the stage update outright. The template is read as text: it carries
 * CloudFormation tags (!Ref, !GetAtt) a plain YAML parser rejects.
 */

const TEMPLATE = readFileSync("infra/sam/template.yaml", "utf8").replace(/\r\n/g, "\n");

/** "METHOD /path" for every HttpApi event in the template. */
function eventRouteKeys(): string[] {
  const keys: string[] = [];
  for (const match of TEMPLATE.matchAll(
    /\n\s+Type: HttpApi\n\s+Properties:\n(?:\s+ApiId: [^\n]+\n)?\s+Path: (\S+)\n\s+Method: (\S+)/g,
  )) {
    keys.push(`${(match[2] ?? "").toUpperCase()} ${match[1] ?? ""}`);
  }
  return keys;
}

/** The RouteSettings keys, each with whether it sets both throttle limits. */
function routeSettings(): Map<string, boolean> {
  const block = /\n(\s+)RouteSettings:\n((?:\1\s+[^\n]*\n)+)/.exec(TEMPLATE);
  const settings = new Map<string, boolean>();
  if (!block) return settings;
  const body = block[2] ?? "";
  const entries = body.split(/\n(?=\s+"[A-Z]+ \/)/);
  for (const entry of entries) {
    const key = /"([A-Z]+ \/[^"]*)":/.exec(entry)?.[1];
    if (!key) continue;
    settings.set(key, /ThrottlingRateLimit: \d+/.test(entry) && /ThrottlingBurstLimit: \d+/.test(entry));
  }
  return settings;
}

describe("SAM template OAuth routes", () => {
  const oauthPaths = [
    OAUTH_PROTECTED_RESOURCE_PATH,
    OAUTH_AUTHORIZATION_SERVER_PATH,
    OAUTH_AUTHORIZE_PATH,
    OAUTH_TOKEN_PATH,
  ];

  it("declares a route and a throttle bucket for every OAuth path the server serves", () => {
    const routes = eventRouteKeys();
    const settings = routeSettings();
    for (const path of oauthPaths) {
      const key = `ANY ${path}`;
      expect(routes, `no HttpApi event for ${key}`).toContain(key);
      expect(settings.get(key), `no throttled RouteSettings entry for ${key}`).toBe(true);
    }
  });

  it("has no RouteSettings entry for a route the template does not declare", () => {
    const routes = new Set(eventRouteKeys());
    const orphans = [...routeSettings().keys()].filter((key) => !routes.has(key));
    expect(orphans).toEqual([]);
  });

  it("reads the template it checks", () => {
    // Guards the two readers above: a layout change that made them return
    // nothing would otherwise pass the orphan check vacuously.
    expect(eventRouteKeys()).toEqual(expect.arrayContaining(["ANY /", "ANY /{proxy+}"]));
    expect(routeSettings().size).toBe(oauthPaths.length);
  });
});
