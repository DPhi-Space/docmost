/**
 * Detection of a non-JSON answer on the JSON API.
 *
 * Every non-exempt `/api` endpoint answers a JSON envelope, and every service
 * function unwraps it blindly (`req.data`). When something between the browser
 * and the server — an authenticating reverse proxy whose session expired, a
 * captive portal, a gateway error page — answers a 2xx with HTML instead, that
 * unwrap yields `undefined` *silently*: plain queries error with "data is
 * undefined", but infinite queries commit the value as a page and report
 * success, which is how a poisoned entry reached the persisted offline cache
 * and crashed every subsequent boot (see `isCorruptInfiniteData` in
 * `features/offline/persistence-policy.ts`).
 *
 * Rejecting the response here turns that whole window into ordinary request
 * errors: queries retry instead of absorbing garbage.
 *
 * Deliberately narrow: only HTML is refused. An empty body, or an unexpected
 * JSON shape, is left to the callers that today tolerate it — this guard must
 * never reject a response a legitimate endpoint produces. Blob/export
 * endpoints are exempted by the interceptor before this check runs.
 */
export function isHtmlApiResponse(contentType: unknown, data: unknown): boolean {
  if (
    typeof contentType === "string" &&
    contentType.toLowerCase().includes("text/html")
  ) {
    return true;
  }
  // A JSON endpoint's body never parses to a string starting with "<": axios
  // leaves the raw text in `data` when JSON.parse fails, so this is the shape
  // an HTML body has after the default response transform.
  return typeof data === "string" && /^\s*</.test(data);
}

/** The error a rejected HTML answer surfaces — named so logs are diagnosable. */
export function htmlApiResponseError(url?: string): Error {
  return new Error(
    `Expected JSON from the API but received HTML${url ? ` (${url})` : ""} — ` +
      "a proxy or gateway likely intercepted the request",
  );
}
