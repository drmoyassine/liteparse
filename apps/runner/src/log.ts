import { randomUUID } from "node:crypto";

/**
 * Per-request structured logging. The caller-supplied VLM config carries a LIVE
 * api key (resolved by the edge per request); redactVlm() guarantees no key
 * value ever reaches a log line or an error response.
 */

export function newRequestId(): string {
  return randomUUID().slice(0, 8);
}

/** Deep-copy `value` with every `apiKey` string property masked. */
export function redactVlm<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (k, v) => (k === "apiKey" && typeof v === "string" ? "***" : v)),
  ) as T;
}

export function logRequest(id: string, msg: string): void {
  console.log(`[runner:${id}] ${msg}`);
}
