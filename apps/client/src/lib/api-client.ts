import axios, { AxiosInstance } from "axios";
import APP_ROUTE from "@/lib/app-route.ts";
import {
  htmlApiResponseError,
  isHtmlApiResponse,
} from "@/lib/api-response-guard.ts";
import { isCloud } from "@/lib/config.ts";
import { clearOfflineDataOnSessionExpiry } from "@/features/offline/session-expiry";
import {
  reportNetworkFailure,
  reportNetworkSuccess,
} from "@/features/offline/reachability";

const api: AxiosInstance = axios.create({
  baseURL: "/api",
  withCredentials: true,
});

api.interceptors.response.use(
  (response) => {
    // The server answered, so it is reachable — the strongest connectivity
    // signal the app has, and free (`features/offline/reachability.ts`). An app
    // in use therefore needs no probes at all, and a wrong "offline" verdict
    // cannot outlive the next successful request.
    reportNetworkSuccess();

    // we need the response headers for these endpoints
    const exemptEndpoints = [
      "/api/pages/export",
      "/api/spaces/export",
      "/api/docx-export",
      "/api/bases/export-csv",
    ];
    if (response.request.responseURL) {
      const path = new URL(response.request.responseURL)?.pathname;
      if (path && exemptEndpoints.includes(path)) {
        return response;
      }
    }

    // A 2xx that is HTML did not come from the API — an auth proxy or gateway
    // answered in its place. Unwrapping it would hand every caller `undefined`,
    // which infinite queries silently commit as a page (and the offline cache
    // then persists). Fail the request instead so queries retry.
    if (isHtmlApiResponse(response.headers?.["content-type"], response.data)) {
      return Promise.reject(
        htmlApiResponseError(response.request.responseURL),
      );
    }

    return response.data;
  },
  (error) => {
    // No `response` means nothing came back at all: DNS, connect, TLS or a
    // timeout. A *hint* that the network is gone, never a verdict — an aborted
    // request is not evidence of anything, and any HTTP status, including 500,
    // proves the round trip completed.
    if (!error.response && error.code !== "ERR_CANCELED") {
      reportNetworkFailure();
    }

    if (error.response) {
      switch (error.response.status) {
        case 401: {
          const url = new URL(error.request.responseURL)?.pathname;
          if (url === "/api/auth/collab-token") return;
          if (window.location.pathname.startsWith("/share/")) return;

          // Handle unauthorized error
          redirectToLogin();
          break;
        }
        case 403:
          // Handle forbidden error
          break;
        case 404:
          // Handle not found error
          if (
            error.response.data.message
              .toLowerCase()
              .includes("workspace not found")
          ) {
            console.log("workspace not found");
            if (
              !isCloud() &&
              window.location.pathname != APP_ROUTE.AUTH.SETUP
            ) {
              window.location.href = APP_ROUTE.AUTH.SETUP;
            }
          }
          break;
        case 500:
          // Handle internal server error
          break;
        default:
          break;
      }
    }
    return Promise.reject(error);
  },
);

function redirectToLogin() {
  // The *session* is over; the **user has not left this machine**. That is the
  // whole difference between this and `handleLogout`, and it is why this path
  // calls `clearOfflineDataOnSessionExpiry()` rather than `clearOfflineData()`:
  // a 401 must not destroy offline edits that exist nowhere else. See the file
  // comment in `session-expiry.ts` before collapsing these two back together.
  //
  // No query client is available outside React context, but the full-page
  // navigation below drops the in-memory cache anyway, and persistence is
  // switched off before the on-disk copy is erased so nothing can be written
  // back.
  void clearOfflineDataOnSessionExpiry();

  const exemptPaths = [
    APP_ROUTE.AUTH.LOGIN,
    APP_ROUTE.AUTH.SIGNUP,
    APP_ROUTE.AUTH.FORGOT_PASSWORD,
    APP_ROUTE.AUTH.PASSWORD_RESET,
    APP_ROUTE.AUTH.MFA_CHALLENGE,
    APP_ROUTE.AUTH.MFA_SETUP_REQUIRED,
    "/invites",
  ];
  if (!exemptPaths.some((path) => window.location.pathname.startsWith(path))) {
    const redirectTo = window.location.pathname;
    if (redirectTo === APP_ROUTE.HOME) {
      window.location.href = APP_ROUTE.AUTH.LOGIN;
    } else {
      const params = new URLSearchParams({ redirect: redirectTo });
      window.location.href = `${APP_ROUTE.AUTH.LOGIN}?${params.toString()}`;
    }
  }
}

export default api;
