// API client — relative paths so it works on any host (observatory server at :31337)

import { apiFetch } from "./api";

function apiCall<T = unknown>(path: string, options?: RequestInit): Promise<T> {
  return apiFetch<T>(path, options);
}

// Exports — keep names for compatibility with existing hooks
export const localApiCall = apiCall;
export const localOnlyApiCall = apiCall;

// WebSocket stubs — observatory uses HTTP polling, not WebSocket
export function getResolvedWsUrl(): Promise<string> {
  return Promise.resolve("");
}
export const getLocalOnlyWsUrl = getResolvedWsUrl;
