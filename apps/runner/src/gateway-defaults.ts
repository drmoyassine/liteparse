/**
 * gateway-defaults.ts — runner-side cloud fallback gateways (owner, 2026-10-19).
 *
 * DEC-083 originally held "the runner stores no secrets beyond its own API
 * key"; the owner amended that so the runner may carry DEFAULT cloud
 * fallback gateways in its environment:
 *
 *   VLM_GATEWAY_ENDPOINT / VLM_GATEWAY_API_KEY / VLM_GATEWAY_MODEL
 *   VLM_GATEWAY_KEY_HEADER (optional)
 *   STT_GATEWAY_ENDPOINT / STT_GATEWAY_API_KEY / STT_GATEWAY_MODEL
 *   STT_GATEWAY_KEY_HEADER (optional)
 *
 * Semantics: a default applies ONLY when the caller supplied none — an
 * explicit caller config always wins, and callers without one (e.g. agents
 * that cannot resolve credentials) inherit the runner's fallback. All-or-
 * nothing per gateway: endpoint + api key + model must all be present. The
 * values are injected AFTER the request log line, and the runner's existing
 * redaction covers every log/echo of the key.
 */
import type {
  RequestedParseOptions,
  RequestedSttOptions,
  RequestedTranscribeOptions,
  RequestedVlmOptions,
} from "./types.js";

function gatewayFromEnv(
  prefix: string,
  env: NodeJS.ProcessEnv,
): { endpoint: string; apiKey: string; model: string; keyHeader?: string } | undefined {
  const endpoint = env[`${prefix}_ENDPOINT`]?.trim();
  const apiKey = env[`${prefix}_API_KEY`]?.trim();
  const model = env[`${prefix}_MODEL`]?.trim();
  if (!endpoint || !apiKey || !model) return undefined;
  const keyHeader = env[`${prefix}_KEY_HEADER`]?.trim();
  return { endpoint, apiKey, model, ...(keyHeader ? { keyHeader } : {}) };
}

export function defaultVlmFromEnv(env: NodeJS.ProcessEnv = process.env): RequestedVlmOptions | undefined {
  return gatewayFromEnv("VLM_GATEWAY", env);
}

export function defaultSttFromEnv(env: NodeJS.ProcessEnv = process.env): RequestedSttOptions | undefined {
  return gatewayFromEnv("STT_GATEWAY", env);
}

/** Caller config wins; env default fills the gap; both absent → unchanged. */
export function withDefaultVlm(
  options: RequestedParseOptions | undefined,
  dflt: RequestedVlmOptions | undefined,
): RequestedParseOptions {
  if (options?.vlm || !dflt) return options ?? {};
  return { ...options, vlm: dflt };
}

export function withDefaultStt(
  options: RequestedTranscribeOptions | undefined,
  dflt: RequestedSttOptions | undefined,
): RequestedTranscribeOptions {
  if (options?.stt || !dflt) return options ?? {};
  return { ...options, stt: dflt };
}
