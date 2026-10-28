"use client";

/**
 * The one way the dashboard talks to the Pulse daemon (Pulse ISA F6).
 *
 * Every read goes through `useApi(path)`, a TanStack Query hook keyed by the path, so two cards reading the same
 * endpoint share one request and one cache entry, a revisited tab paints from cache at once, and polling
 * (`refetchInterval`) pauses while the browser tab is hidden. Every write goes through `useApiMutation`.
 * This file holds the dashboard's only raw `fetch` call; ISC-26 fails on any other.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationOptions,
  type UseQueryOptions,
} from "@tanstack/react-query";

export class ApiError extends Error {
  constructor(public status: number, public path: string, public body: string) {
    super(`API ${status} on ${path}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
}

type Parse = "json" | "text";

/** Fetch a Pulse path and parse it. Throws ApiError on a non-2xx status. */
export async function apiFetch<T = unknown>(path: string, init?: RequestInit & { parse?: Parse }): Promise<T> {
  const { parse = "json", ...rest } = init ?? {};
  const headers = new Headers(rest.headers);
  if (rest.body !== undefined && typeof rest.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(path, { cache: "no-store", ...rest, headers });
  if (!res.ok) throw new ApiError(res.status, path, await res.text().catch(() => ""));
  if (parse === "text") return (await res.text()) as T;
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** POST/PUT/DELETE a JSON body (or none) to a Pulse path. */
export function apiSend<T = unknown>(path: string, method: "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown, init?: RequestInit): Promise<T> {
  return apiFetch<T>(path, { ...init, method, body: body === undefined ? undefined : JSON.stringify(body) });
}

/** The query key for a path. Keyed by path alone, so the same endpoint is the same cache entry everywhere. */
export const apiKey = (path: string) => ["api", path] as const;

/** A read that gets no answer in this long is aborted with a TimeoutError, so a hung daemon reads as an error. */
export const READ_TIMEOUT_MS = 30_000;

/** Query options for a path, shared by the hook and by imperative fetchQuery/prefetchQuery calls. */
export function apiQuery<T>(path: string, parse: Parse = "json", timeoutMs = READ_TIMEOUT_MS) {
  return {
    queryKey: parse === "json" ? apiKey(path) : (["api", path, parse] as const),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      apiFetch<T>(path, { signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]), parse }),
  };
}

type ApiQueryOpts<T, S> = Omit<UseQueryOptions<T, Error, S>, "queryKey" | "queryFn"> & { parse?: Parse };

/**
 * Read a Pulse path. Pass `null` to wait (the query stays disabled until a path exists).
 * Polling: `{ refetchInterval: 60_000 }` replaces a hand-rolled setInterval and pauses on a hidden tab.
 */
export function useApi<T = unknown, S = T>(path: string | null | undefined, opts: ApiQueryOpts<T, S> = {}) {
  const { parse = "json", enabled, ...rest } = opts;
  const base = apiQuery<T>(path ?? "", parse);
  return useQuery<T, Error, S>({
    ...rest,
    queryKey: base.queryKey,
    queryFn: base.queryFn,
    enabled: !!path && enabled !== false,
  });
}

/** Mark every cached read whose path starts with one of these prefixes stale, so mounted readers refetch. */
export function invalidateApi(client: QueryClient, ...prefixes: string[]) {
  return client.invalidateQueries({
    predicate: (q) => q.queryKey[0] === "api" && typeof q.queryKey[1] === "string" && prefixes.some((p) => (q.queryKey[1] as string).startsWith(p)),
  });
}

/**
 * A write. `mutationFn` does the request (usually `apiSend`); `invalidates` lists path prefixes to refetch on success.
 */
export function useApiMutation<TData = unknown, TVars = void>(
  mutationFn: (vars: TVars) => Promise<TData>,
  opts: Omit<UseMutationOptions<TData, Error, TVars>, "mutationFn"> & { invalidates?: string[] } = {},
) {
  const client = useQueryClient();
  const { invalidates, onSuccess, ...rest } = opts;
  return useMutation<TData, Error, TVars>({
    ...rest,
    mutationFn,
    onSuccess: async (data, vars, ctx, mctx) => {
      if (invalidates?.length) await invalidateApi(client, ...invalidates);
      await onSuccess?.(data, vars, ctx, mctx);
    },
  });
}
