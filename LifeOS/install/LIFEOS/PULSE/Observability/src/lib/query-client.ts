import { QueryClient } from "@tanstack/react-query";

/**
 * The dashboard's QueryClient (Pulse ISA F6). A revisited tab paints from cache (staleTime, gcTime), polling
 * pauses while the browser tab is hidden (refetchIntervalInBackground stays false), and data refreshes when the
 * tab comes back (refetchOnWindowFocus).
 */
export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 10 * 60_000,
        refetchOnWindowFocus: true,
        refetchIntervalInBackground: false,
        retry: 1,
      },
    },
  });
}
