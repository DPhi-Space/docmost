/**
 * Reading a collaboration token without throwing.
 *
 * `page-editor.tsx`'s `onAuthenticationFailed` used to do this:
 *
 * ```js
 * const payload = jwtDecode(collabQuery?.token);
 * const isTokenExpired = Date.now() / 1000 >= payload.exp;
 * ```
 *
 * `jwtDecode(undefined)` throws `Invalid token specified` — and the token *is*
 * undefined on an offline boot, because `["collab-token"]` is a live JWT and is
 * deliberately excluded from the persisted query cache (`persistence-policy.ts`).
 * Phase 1b made that path reachable and recorded it as this issue's to fix.
 *
 * "Cannot tell" answers **expired**, which routes the caller into its existing
 * refetch-and-reconnect branch. That is the correct default in both directions:
 * with no network the refetch fails harmlessly and the socket keeps retrying;
 * with a network it produces a fresh token, which is exactly what a session
 * holding no readable token needs.
 */

import { jwtDecode } from "jwt-decode";

/**
 * Is this collaboration token expired, missing, or unreadable?
 *
 * A `false` answer is therefore a strong statement: the token was decoded and
 * carries an expiry still in the future. An authentication failure with such a
 * token is not about the token at all — the page was hard-deleted, or the
 * user's access to it was revoked.
 */
export function isCollabTokenExpired(
  token: string | undefined | null,
  nowMs: number = Date.now(),
): boolean {
  if (!token) return true;
  try {
    const { exp } = jwtDecode<{ exp?: number }>(token);
    if (typeof exp !== "number") return true;
    return nowMs / 1000 >= exp;
  } catch {
    return true;
  }
}
