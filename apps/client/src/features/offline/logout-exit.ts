/**
 * The client side of an explicit logout, made unstoppable.
 *
 * ## The defect this exists to fix
 *
 * `handleLogout` used to be three awaited statements in a row: reset the user
 * atom, `POST /api/auth/logout`, then `clearOfflineData()` and the redirect.
 * Logging out while the server is unreachable made the second statement reject
 * with a transport error — so the privacy cleanup never ran, the redirect never
 * happened, and the app was left wedged on a "Failed to load page" screen that
 * survived reload (the user atom was reset but the session cookie and every
 * offline store were still in place). Recovery required logging out *again*
 * once back online. Reproduced in a real browser during the #21 verification
 * pass.
 *
 * That inversion is exactly wrong for a privacy exit: the user clicking Logout
 * on a shared machine is the one moment the client-side erase must be
 * unconditional (#18), and it is the moment least likely to have a network —
 * people log out as they walk away.
 *
 * ## The rule
 *
 * The server call is **best effort**; the client-side exit is **guaranteed**.
 * Order is kept (server first) so that when the network is up the session is
 * invalidated before the local state is torn down, but no failure of any step
 * may prevent the steps after it, and the navigation to the login page always
 * happens.
 *
 * ## The residue, stated plainly
 *
 * An offline logout cannot invalidate the server-side session: the `authToken`
 * cookie is httpOnly (script cannot delete it) and the `POST /api/auth/logout`
 * that would revoke the session and clear the cookie never reached the server.
 * The session therefore survives server-side until it expires. What the exit
 * *does* guarantee is everything under the client's control: offline stores
 * erased, in-memory state dropped, and the tab on the login page. Documented in
 * AGENTS.md rather than hidden.
 */

export interface LogoutExitDeps {
  /** `POST /api/auth/logout` — revokes the session and clears the cookie. */
  serverLogout: () => Promise<unknown>;
  /** The unconditional #18 privacy erase (`clear-offline-data.ts`). */
  clearOfflineData: () => Promise<void>;
  /** Full-page navigation to the login route. */
  navigateToLogin: () => void;
  /** Diagnostic only; a logout must stay quiet in the happy path. */
  log?: (message: string, detail?: unknown) => void;
}

/**
 * Run the logout exit. Never rejects, and `navigateToLogin` runs no matter
 * which earlier step failed — a logout that leaves the user *in* the app is a
 * worse failure than any partial cleanup, because every store the cleanup
 * missed is still guarded by `data-ownership.ts` while a wedged session is
 * guarded by nothing.
 */
export async function performLogoutExit(deps: LogoutExitDeps): Promise<void> {
  const log = deps.log ?? (() => {});

  try {
    await deps.serverLogout();
  } catch (error) {
    // Transport failure (offline logout) or a server refusal: either way the
    // user is leaving. The server-side session survives until expiry — the
    // documented residue — but the local exit proceeds in full.
    log("logout: server call failed, continuing with local exit", error);
  }

  try {
    await deps.clearOfflineData();
  } catch (error) {
    // `clearOfflineData` is itself best-effort and should not throw; if it
    // somehow does, the redirect must still happen.
    log("logout: offline cleanup failed", error);
  }

  deps.navigateToLogin();
}
