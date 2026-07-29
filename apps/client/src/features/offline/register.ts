/**
 * Service-worker registration and update wiring.
 *
 * Importing this module registers the worker as a side effect (production
 * builds only) — that keeps the touch on `main.tsx` to a single import line,
 * which matters for rebase friendliness against upstream.
 */

import { createUpdateController } from "./update-state";
import {
  hideUpdateNotification,
  showUpdateNotification,
} from "./update-notification";

const SW_URL = "/sw.js";
const SW_SCOPE = "/";
/** How often to ask the browser to re-check `sw.js` while a tab stays open. */
const UPDATE_POLL_MS = 30 * 60 * 1000;

let registered = false;

export function registerServiceWorker(): void {
  if (registered) return;
  if (typeof window === "undefined") return;
  if (!("serviceWorker" in navigator)) return;
  registered = true;

  const controller = createUpdateController((effect) => {
    switch (effect) {
      case "show-prompt":
        showUpdateNotification({
          onReload: () => controller.send({ type: "reload-requested" }),
          onDismiss: () => controller.send({ type: "dismissed" }),
        });
        break;
      case "hide-prompt":
        hideUpdateNotification();
        break;
      case "skip-waiting":
        waiting?.postMessage({ type: "SKIP_WAITING" });
        break;
      case "reload-page":
        window.location.reload();
        break;
    }
  });

  let waiting: ServiceWorker | null = null;

  const noteWaiting = (worker: ServiceWorker | null) => {
    if (!worker) return;
    waiting = worker;
    controller.send({ type: "waiting-detected" });
  };

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    controller.send({ type: "controller-changed" });
  });

  const start = async () => {
    try {
      const registration = await navigator.serviceWorker.register(SW_URL, {
        scope: SW_SCOPE,
        type: "classic",
      });

      // A worker may already be waiting from a previous visit.
      noteWaiting(registration.waiting);

      registration.addEventListener("updatefound", () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener("statechange", () => {
          // `controller` present means this is an update, not a first install.
          if (
            installing.state === "installed" &&
            navigator.serviceWorker.controller
          ) {
            noteWaiting(registration.waiting ?? installing);
          }
        });
      });

      window.setInterval(() => {
        registration.update().catch(() => {
          /* offline or transient: the next poll retries */
        });
      }, UPDATE_POLL_MS);
    } catch (error) {
      // Registration failures must never break the app: without a worker it
      // simply behaves exactly as it did before this feature existed.
      console.warn("Service worker registration failed", error);
    }
  };

  if (document.readyState === "complete") {
    void start();
  } else {
    window.addEventListener("load", () => void start(), { once: true });
  }
}

// Dev is served by the Vite dev server, which has no `/sw.js`; the SPA fallback
// would answer with HTML and the browser would reject the registration on MIME
// type. Use `vite preview` or the docker image to exercise the worker.
if (import.meta.env.PROD) {
  registerServiceWorker();
}
