export const PRODUCT_NAME = "HomeAgent" as const;
export const PRODUCT_SLUG = "homeagent" as const;
export const PRODUCT_ENV_PREFIX = "HOMEAGENT" as const;
export const LEGACY_PRODUCT_ENV_PREFIX = "HOMEBRAIN" as const;

/**
 * Read a branded environment variable while keeping pre-rename installs
 * functional. An explicitly supplied HOMEAGENT_* value always wins, including
 * an empty value used to clear an optional setting.
 */
export function brandedEnv(
  env: NodeJS.ProcessEnv,
  suffix: string,
): string | undefined {
  return env[`${PRODUCT_ENV_PREFIX}_${suffix}`]
    ?? env[`${LEGACY_PRODUCT_ENV_PREFIX}_${suffix}`];
}
