/**
 * The collaboration socket as a connectivity signal.
 *
 * A tab sitting on a page makes no HTTP requests at all — the editor talks over
 * a WebSocket, and the app's query defaults are `refetchOnMount: false` with a
 * five-minute `staleTime` — so the socket is usually the *first* thing in the
 * app to notice that a network has died, and often the only thing. Feeding it
 * into `reachability.ts` is what turns "the user's Wi-Fi dropped while they were
 * reading" from a state discovered on their next click into one discovered in
 * seconds.
 *
 * Two rules keep it honest:
 *
 * 1. **A connection is proof; a disconnection is a hint.** `Connected` means the
 *    socket completed a handshake with the server, which is evidence of
 *    reachability as strong as an HTTP response, so it is reported as such.
 *    Losing the socket, on the other hand, has plenty of explanations that are
 *    not a dead network (a server restart, an idle timeout, a proxy) — so it only
 *    ever prompts a probe.
 * 2. **A drop has to persist to count.** Every page navigation destroys and
 *    rebuilds the provider, so the status leaves `Connected` constantly during
 *    ordinary use. Reporting immediately would fire a probe per navigation for
 *    nothing; {@link DISCONNECT_GRACE_MS} of *continuous* disconnection is what
 *    distinguishes a rebuild from a problem.
 *
 * Hosted by `offline-indicator.tsx`, which `layout.tsx` already mounts once per
 * authenticated session — so this reads the collaboration status without adding
 * a line to any collaboration file. It is deliberately app-wide rather than
 * per-editor, and deliberately *not* gated on the offline-editing switch: the
 * reachability verdict drives the offline pill and React Query's pausing too,
 * both of which phases 1a/1b ship unconditionally.
 */

import { useEffect } from "react";
import { useAtomValue } from "jotai";
import { WebSocketStatus } from "@hocuspocus/provider";
import { yjsConnectionStatusAtom } from "@/features/editor/atoms/editor-atoms";
import { reportNetworkFailure, reportNetworkSuccess } from "./reachability";

/** How long the socket must stay down before it is treated as a hint. */
export const DISCONNECT_GRACE_MS = 3_000;

export function useCollabConnectionWatch(): void {
  const status = useAtomValue(yjsConnectionStatusAtom);

  useEffect(() => {
    // The atom starts as `""` and keeps its last value once no editor is
    // mounted; neither state says anything about the network.
    if (!status) return;

    if (status === WebSocketStatus.Connected) {
      reportNetworkSuccess();
      return;
    }

    // React runs this cleanup before the next effect, so the grace period only
    // elapses while the status has not changed — which is the whole point.
    const handle = setTimeout(reportNetworkFailure, DISCONNECT_GRACE_MS);
    return () => clearTimeout(handle);
  }, [status]);
}
