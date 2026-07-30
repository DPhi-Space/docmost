import { useQuery, UseQueryResult } from "@tanstack/react-query";
import { getCollabToken, verifyUserToken } from "../services/auth-service";
import { ICollabToken, IVerifyUserToken } from "../types/auth.types";
import { isAxiosError } from "axios";

export function useVerifyUserTokenQuery(
  verify: IVerifyUserToken,
): UseQueryResult<any, Error> {
  return useQuery({
    queryKey: ["verify-token", verify],
    queryFn: () => verifyUserToken(verify),
    enabled: !!verify.token,
    staleTime: 0,
  });
}

/**
 * Exported for tests. `error.response` is **undefined** for transport-level
 * failures (offline, aborted, DNS), and the unguarded `error.response.status`
 * this replaces crashed *inside React Query's retry evaluation* with an
 * uncaught `TypeError: Cannot read properties of undefined (reading 'status')`
 * whenever a collab-token refetch met the first seconds of an outage — seen in
 * a real browser during the #21 offline verification, where it also broke the
 * query's own retry loop. Behaviour is otherwise upstream's: never retry a
 * 404, retry everything else.
 */
export function collabTokenRetry(_failureCount: number, error: unknown): boolean {
  return !(isAxiosError(error) && error.response?.status === 404);
}

export function useCollabToken(): UseQueryResult<ICollabToken, Error> {
  return useQuery({
    queryKey: ["collab-token"],
    queryFn: () => getCollabToken(),
    staleTime: 20 * 60 * 60 * 1000, //20hrs
    //refetchInterval: 12 * 60 * 60 * 1000, // 12hrs
    //refetchIntervalInBackground: true,
    refetchOnMount: true,
    // Typed wrapper so TError stays `Error` for the query's consumers; the
    // policy itself accepts `unknown` because transport failures are not
    // guaranteed to be AxiosErrors.
    retry: (failureCount: number, error: Error) =>
      collabTokenRetry(failureCount, error),
    retryDelay: (retryAttempt) => {
      // Exponential backoff: 5s, 10s, 20s, etc.
      return 5000 * Math.pow(2, retryAttempt - 1);
    },
  });
}
