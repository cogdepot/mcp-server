/**
 * Loads the hosted server's stage key from SSM Parameter Store.
 *
 * The hosted server takes the parameter's NAME (COGDEPOT_STAGE_KEY_PARAM), never
 * the key itself, so the key stays out of the function's configuration, where
 * anyone who can read the function could read it too. Only the remote Lambda
 * imports this; the stdio server and a local remote server take the key as a
 * value (stage-key.ts).
 *
 * Production sets no parameter name, and then nothing here runs at all.
 */

import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

import { setStageKey } from "./stage-key.js";

/** The minimal SSM surface this needs, so a test can hand in a fake. */
export interface ParameterReader {
  send(command: GetParameterCommand): Promise<{ Parameter?: { Value?: string } }>;
}

export class StageKeyLoadError extends Error {
  override readonly name = "StageKeyLoadError";
}

/**
 * Reads the named SecureString and applies it as the stage key.
 *
 * Any failure throws, and the caller fails the request: once the deployment's
 * gate refuses keyless calls, a server running without its key would answer
 * every tool with an error that names the gate rather than the cause. The
 * parameter's name is in the message; its value never is.
 */
export async function loadStageKeyFromSsm(
  parameterName: string,
  reader: ParameterReader = new SSMClient({}),
): Promise<void> {
  let value: string | undefined;
  try {
    const result = await reader.send(
      new GetParameterCommand({ Name: parameterName, WithDecryption: true }),
    );
    value = result.Parameter?.Value;
  } catch (error) {
    const cause = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new StageKeyLoadError(`could not read the stage key parameter ${parameterName}: ${cause}`);
  }
  if (value === undefined) {
    throw new StageKeyLoadError(`the stage key parameter ${parameterName} has no value`);
  }
  setStageKey(value);
}

/**
 * Returns a function that loads the stage key once and then remembers it.
 *
 * Only a success is remembered. A failed read (a permission not yet granted, a
 * throttled call) is retried on the next request instead of poisoning the
 * container for its whole life, and each request it fails reports why.
 */
export function stageKeyLoader(
  parameterName: string | undefined,
  load: (name: string) => Promise<void> = (name) => loadStageKeyFromSsm(name),
): () => Promise<void> {
  const name = parameterName?.trim();
  if (!name) return async () => {};
  let loaded: Promise<void> | undefined;
  return async () => {
    loaded ??= load(name).catch((error: unknown) => {
      loaded = undefined;
      throw error;
    });
    await loaded;
  };
}
