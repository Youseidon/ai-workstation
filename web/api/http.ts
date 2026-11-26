/** Cookie authentication is shared by every API request, including settings. */
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, { ...init, credentials: "include" });
  if (response.status === 401 && typeof window !== "undefined") window.dispatchEvent(new Event("hydra.session-expired"));
  return response;
}
