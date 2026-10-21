// One GET or DELETE to the server, as JSON. Throws with the server's own message when the answer is not ok.

// Body: what the endpoint answers (see api-types.ts); null for a 204.
export async function fetchJson<Body>(url: string, options: RequestInit = {}): Promise<Body> {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  if (response.status === 204) return null as Body;
  return (await response.json()) as Body;
}
