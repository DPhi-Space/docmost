import { Logger } from '@nestjs/common';

export interface OidcSettings {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  requiredRole: string | null;
}

const logger = new Logger('OidcSettings');
let warnedIncomplete = false;

/**
 * Null means the feature is off. It is on only when the issuer is set, and only
 * on self-hosted installs: the callback URL is derived from APP_URL, which a
 * multi-workspace cloud deployment does not route to a workspace.
 */
export function readOidcSettings(
  env: NodeJS.ProcessEnv = process.env,
): OidcSettings | null {
  const issuerUrl = env.OIDC_ISSUER_URL?.trim();
  if (!issuerUrl) return null;
  if (env.CLOUD?.toLowerCase() === 'true') return null;

  const clientId = env.OIDC_CLIENT_ID?.trim();
  const clientSecret = env.OIDC_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    if (!warnedIncomplete) {
      warnedIncomplete = true;
      logger.error(
        'OIDC_ISSUER_URL is set but OIDC_CLIENT_ID or OIDC_CLIENT_SECRET is missing; OIDC sign-in is disabled',
      );
    }
    return null;
  }

  return {
    issuerUrl,
    clientId,
    clientSecret,
    requiredRole: env.OIDC_REQUIRED_ROLE?.trim() || null,
  };
}

export function isOidcEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readOidcSettings(env) !== null;
}
