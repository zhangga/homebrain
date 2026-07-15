const LARK_VERIFICATION_HOSTS = new Set(["open.feishu.cn", "open.larksuite.com"]);
const LARK_VERIFICATION_PATHS = new Set(["/page/cli", "/page/launcher"]);

export function safeLarkVerificationUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:"
      || parsed.username
      || parsed.password
      || parsed.port
      || !LARK_VERIFICATION_HOSTS.has(parsed.hostname)
      || !LARK_VERIFICATION_PATHS.has(parsed.pathname)
    ) {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}
