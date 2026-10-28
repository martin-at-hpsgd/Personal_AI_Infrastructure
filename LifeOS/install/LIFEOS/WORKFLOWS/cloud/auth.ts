/**
 * Bearer check for the cloud runner (ISC-133).
 *
 * Both sides are hashed with SHA-256 before comparison, so the compare always
 * walks 32 bytes whatever the lengths are, and it XOR-folds every byte instead
 * of returning at the first mismatch. An unset or empty token refuses every
 * request: the runner fails closed.
 */
const encoder = new TextEncoder();

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** True only when `expected` is a non-empty token and the header is exactly `Bearer <expected>`. */
export async function bearerAuthorized(header: string | null, expected: string | undefined): Promise<boolean> {
  if (typeof expected !== "string" || expected.length === 0) return false;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  return constantTimeEqual(header.slice("Bearer ".length), expected);
}
