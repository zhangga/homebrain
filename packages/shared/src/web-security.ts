/** Whether a Bun server hostname is confined to the local machine. */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized === "localhost" || normalized === "::1" || normalized === "[::1]") {
    return true;
  }
  const octets = normalized.split(".");
  return octets.length === 4
    && octets[0] === "127"
    && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** Refuse to expose the management backend without an explicit credential. */
export function assertSafeWebBinding(host: string, adminToken?: string): void {
  if (isLoopbackHost(host) || adminToken?.trim()) return;
  throw new Error(
    `HOMEAGENT_WEB_ADMIN_TOKEN is required when HOMEAGENT_WEB_HOST is non-local (${host})`,
  );
}
