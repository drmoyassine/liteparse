import { createHash, timingSafeEqual } from "node:crypto";

/**
 * X-API-Key authentication with timing-safe comparison.
 *
 * Both sides are SHA-256 digested before timingSafeEqual so the comparison is
 * length-independent (comparing raw buffers of different lengths throws AND
 * leaks the expected key's length through timing). Same pattern as studygram's
 * agent-create-communication edge function.
 */
export function createApiKeyAuth(expectedKey: string): (provided: string | undefined) => boolean {
  const expected = createHash("sha256").update(expectedKey, "utf8").digest();
  return (provided) => {
    if (!provided) return false;
    const actual = createHash("sha256").update(provided, "utf8").digest();
    return timingSafeEqual(actual, expected);
  };
}
