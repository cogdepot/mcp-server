/**
 * The AWS Lambda entrypoint for the remote MCP server.
 *
 * Adapts an API Gateway v2 (HTTP API) proxy event to the web-standard
 * `fetch(Request)` handler that createRemoteHandler returns, and adapts the
 * Response back. The handler is built once per container (module scope) so a warm
 * invocation reuses it - and, with OAuth configured, reuses its cached JWKS
 * rather than refetching per request.
 *
 * Buffered, not streamed: API Gateway returns one response, and the handler runs
 * in JSON response mode (see remote.ts) to match. The public URL the client used
 * reaches the handler through the Host header, so the OAuth protected-resource
 * metadata URL and the `resource` check resolve against the real domain rather
 * than the Lambda's internal name.
 */

import { Buffer } from "node:buffer";

import { createRemoteHandler } from "./remote.js";

// Built once per container. A misconfigured deploy - a bad base URL, a half-set
// OAuth config - throws here and fails the cold start, rather than serving a
// broken server; the same fail-fast the base-URL and OAuth checks already make.
const remoteHandler = createRemoteHandler();

/** The subset of the API Gateway v2 (HTTP API) proxy event this adapter reads. */
interface ApiGatewayV2Event {
  readonly rawPath?: string;
  readonly rawQueryString?: string;
  readonly headers?: Record<string, string | undefined>;
  readonly cookies?: string[];
  readonly body?: string;
  readonly isBase64Encoded?: boolean;
  readonly requestContext: {
    readonly http: { readonly method: string };
    readonly domainName?: string;
  };
}

/** The API Gateway v2 proxy result shape. */
interface ApiGatewayV2Result {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: boolean;
}

export async function handler(event: ApiGatewayV2Event): Promise<ApiGatewayV2Result> {
  const request = toRequest(event);
  const response = await remoteHandler.fetch(request);
  const result = await toResult(response);
  // Access log: one compact line per request so a failing OAuth flow can be
  // traced by path and status in CloudWatch. Auth failures answer 401/502 rather
  // than throwing, so without this they leave no trace.
  const path = event.rawPath ?? "/";
  const authed = event.headers?.["authorization"] ? " bearer" : "";
  // stderr, not stdout: stdout is reserved as the stdio transport's protocol
  // channel (a shipped-wide rule), and CloudWatch captures both streams anyway.
  process.stderr.write(`mcp ${event.requestContext.http.method} ${path}${authed} -> ${result.statusCode}\n`);
  return result;
}

function toRequest(event: ApiGatewayV2Event): Request {
  const method = event.requestContext.http.method;
  // The Host header is the public domain the client actually addressed; the OAuth
  // gate derives the metadata URL from it, so it must be the real host, not the
  // Lambda's. domainName is the API Gateway fallback if Host is somehow absent.
  const host = event.headers?.["host"] ?? event.requestContext.domainName ?? "localhost";
  const path = event.rawPath ?? "/";
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";

  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined) headers.set(name, value);
  }
  if (event.cookies && event.cookies.length > 0) {
    headers.set("cookie", event.cookies.join("; "));
  }

  const init: RequestInit = { method, headers };
  // A GET/HEAD Request must carry no body, and Request throws if one is passed;
  // assign body only when there is one, so exactOptionalPropertyTypes is honoured.
  // MCP request bodies are JSON text, so a base64-encoded body decodes to a utf-8
  // string rather than being carried as bytes.
  if (method !== "GET" && method !== "HEAD" && event.body !== undefined) {
    init.body = event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body;
  }

  return new Request(`https://${host}${path}${query}`, init);
}

async function toResult(response: Response): Promise<ApiGatewayV2Result> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return {
    statusCode: response.status,
    headers,
    // The handler answers with buffered JSON (or a small problem/metadata
    // document), so text is the whole body and base64 is unnecessary.
    body: await response.text(),
    isBase64Encoded: false,
  };
}
