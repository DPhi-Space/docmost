import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

export const OIDC_COOKIE_PATH = '/api/oidc';
export const OIDC_STATE_COOKIE = 'oidcState';
export const OIDC_ID_TOKEN_COOKIE = 'oidcIdToken';
export const OIDC_STATE_TTL_MS = 10 * 60 * 1000;

export interface OidcFlowState {
  state: string;
  nonce: string;
  codeVerifier: string;
  redirect: string | null;
  exp: number;
}

// Own key, so a signature made with APP_SECRET for anything else never verifies here.
function stateKey(appSecret: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', appSecret, '', 'oidc-sign-in-state', 32),
  );
}

function sign(data: string, appSecret: string): string {
  return createHmac('sha256', stateKey(appSecret))
    .update(data)
    .digest('base64url');
}

export function encodeFlowState(
  flow: OidcFlowState,
  appSecret: string,
): string {
  const data = Buffer.from(JSON.stringify(flow)).toString('base64url');
  return `${data}.${sign(data, appSecret)}`;
}

export function decodeFlowState(
  cookie: string | undefined,
  appSecret: string,
  now = Date.now(),
): OidcFlowState | null {
  if (!cookie) return null;
  const dot = cookie.lastIndexOf('.');
  if (dot <= 0) return null;

  const data = cookie.substring(0, dot);
  const given = Buffer.from(cookie.substring(dot + 1));
  const expected = Buffer.from(sign(data, appSecret));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }

  let flow: Partial<OidcFlowState>;
  try {
    flow = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (
    typeof flow?.state !== 'string' ||
    typeof flow.nonce !== 'string' ||
    typeof flow.codeVerifier !== 'string' ||
    typeof flow.exp !== 'number' ||
    flow.exp <= now
  ) {
    return null;
  }

  return {
    state: flow.state,
    nonce: flow.nonce,
    codeVerifier: flow.codeVerifier,
    redirect: typeof flow.redirect === 'string' ? flow.redirect : null,
    exp: flow.exp,
  };
}

/**
 * Same rules as the client's `safeRedirectPath` (apps/client/src/lib/app-route.ts):
 * only a same-origin relative path survives. API paths are refused too, since
 * none of them is a page to land on.
 */
export function safeRedirectPath(
  input: unknown,
  appUrl: string,
): string | null {
  if (typeof input !== 'string') return null;
  if (input.length === 0 || input.length > 2048) return null;
  if (/[\s\\]|\p{C}/u.test(input)) return null;
  if (!input.startsWith('/') || input.startsWith('//')) return null;
  if (input.toLowerCase().includes('://')) return null;
  if (/^\/[a-z][a-z0-9+\-.]*:/i.test(input)) return null;
  try {
    const base = new URL(appUrl);
    const resolved = new URL(input, base);
    if (resolved.origin !== base.origin) return null;
    if (resolved.pathname === '/api' || resolved.pathname.startsWith('/api/')) {
      return null;
    }
    // URL parsing collapses dot-segments ("/.//evil.com" becomes "//evil.com"),
    // so the normalised output needs the same check as the input.
    const output = resolved.pathname + resolved.search + resolved.hash;
    if (output.startsWith('//') || output.startsWith('/\\')) return null;
    return output;
  } catch {
    return null;
  }
}
