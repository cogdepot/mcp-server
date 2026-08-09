/**
 * Shared tool-result shaping.
 *
 * Every tool funnels failures through `toolError`, so the rules in errors.ts
 * cannot be sidestepped by a handler that catches and formats its own way. The
 * spec draws a line this respects: protocol errors are JSON-RPC errors, while
 * *tool execution* errors belong in the result with `isError: true`, because
 * clients feed those back to the model for self-correction. A tool that throws
 * on a recoverable failure denies the model the chance to fix it.
 *
 * The return types are inferred rather than declared. The SDK's result type is
 * a union that now includes `InputRequiredResult`, and a hand-written interface
 * silently stops matching it the moment the spec grows a new result kind.
 */

import { MissingApiKeyError } from "./client.js";
import { ApiError } from "./errors.js";

export function toolText(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * Renders any thrown value as an actionable tool error.
 *
 * Deliberately never includes a stack: the reader is a language model deciding
 * what to do next, and a stack teaches it nothing it can act on.
 */
export function toolError(error: unknown) {
  if (error instanceof MissingApiKeyError) {
    return { content: [{ type: "text" as const, text: error.message }], isError: true };
  }
  if (error instanceof ApiError) {
    const retry = error.retryable ? "" : "\nDo not retry this call unchanged.";
    return {
      content: [{ type: "text" as const, text: `${error.message}${retry}` }],
      isError: true,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: `Unexpected failure: ${message}` }],
    isError: true,
  };
}
