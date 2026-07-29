/**
 * The offline boot gate.
 *
 * Phase 1a shipped a service worker that boots the shell with no network, and
 * the app still rendered a white screen: `UserProvider` returned an empty
 * fragment whenever `/users/me` was loading or errored. Persisting the query
 * cache only helps if the provider is willing to render from it, so this suite
 * pins exactly when children appear.
 *
 * It lives under `features/offline` because it exists for offline mode; the
 * change it covers is five lines in `features/user/user-provider.tsx`.
 */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useCurrentUser = vi.fn();
const useIsRestoring = vi.fn(() => false);

vi.mock("@tanstack/react-query", () => ({ useIsRestoring }));
vi.mock("@/features/user/hooks/use-current-user", () => ({
  default: useCurrentUser,
}));
vi.mock("@/ee/entitlement/use-entitlements", () => ({
  useEntitlements: () => ({ data: undefined }),
}));
vi.mock("@/features/auth/queries/auth-query.tsx", () => ({
  useCollabToken: () => ({ data: undefined }),
}));
vi.mock("@/features/websocket/use-query-subscription.ts", () => ({
  useQuerySubscription: () => {},
}));
vi.mock("@/features/websocket/use-tree-socket.ts", () => ({
  useTreeSocket: () => {},
}));
vi.mock("@/features/notification/hooks/use-notification-socket.ts", () => ({
  useNotificationSocket: () => {},
}));
vi.mock("socket.io-client", () => ({ io: () => ({ on: () => {}, disconnect: () => {} }) }));
vi.mock("@/components/ui/error-404.tsx", () => ({
  Error404: () => <div>not-found</div>,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { changeLanguage: () => {}, language: "en-US", resolvedLanguage: "en-US" },
  }),
}));

const { UserProvider } = await import("@/features/user/user-provider");

const cachedUser = {
  user: { id: "u1", locale: "en" },
  workspace: { id: "w1" },
};

/** The shape `useQuery` reports in each situation this gate has to handle. */
const queryState = (over: Record<string, unknown>) => ({
  data: undefined,
  isLoading: false,
  isError: false,
  error: null,
  ...over,
});

function renderProvider() {
  return render(
    <UserProvider>
      <div>app</div>
    </UserProvider>,
  );
}

describe("UserProvider offline gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useIsRestoring.mockReturnValue(false);
  });

  it("renders the app offline: /users/me failed but the cache restored a user", () => {
    // React Query pauses fetches while the browser is offline, so the restored
    // data is present with a network error alongside it.
    useCurrentUser.mockReturnValue(
      queryState({
        data: cachedUser,
        isError: true,
        error: { message: "Network Error" },
      }),
    );

    renderProvider();

    expect(screen.getByText("app")).toBeDefined();
  });

  it("renders the app when /users/me returns a server error but data is cached", () => {
    useCurrentUser.mockReturnValue(
      queryState({
        data: cachedUser,
        isError: true,
        error: { response: { status: 500 } },
      }),
    );

    renderProvider();

    expect(screen.getByText("app")).toBeDefined();
  });

  it("renders the app while a background refetch is in flight over cached data", () => {
    useCurrentUser.mockReturnValue(
      queryState({ data: cachedUser, isLoading: true }),
    );

    renderProvider();

    expect(screen.getByText("app")).toBeDefined();
  });

  it("stays blank while the persisted cache is still being restored", () => {
    // Restoring is asynchronous and reports no data and no error, which is
    // indistinguishable from "logged out" — rendering here would flash an
    // unauthenticated app on every reload.
    useIsRestoring.mockReturnValue(true);
    useCurrentUser.mockReturnValue(queryState({}));

    renderProvider();

    expect(screen.queryByText("app")).toBeNull();
  });

  it("stays blank on a first-ever offline visit, with nothing cached", () => {
    useCurrentUser.mockReturnValue(
      queryState({ isError: true, error: { message: "Network Error" } }),
    );

    renderProvider();

    expect(screen.queryByText("app")).toBeNull();
  });

  it("stays blank while the very first /users/me is loading", () => {
    useCurrentUser.mockReturnValue(queryState({ isLoading: true }));

    renderProvider();

    expect(screen.queryByText("app")).toBeNull();
  });

  it("still shows the 404 workspace page, cached user or not", () => {
    useCurrentUser.mockReturnValue(
      queryState({
        data: cachedUser,
        isError: true,
        error: { response: { status: 404 } },
      }),
    );

    renderProvider();

    expect(screen.getByText("not-found")).toBeDefined();
    expect(screen.queryByText("app")).toBeNull();
  });
});
