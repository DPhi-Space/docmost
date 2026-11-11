import { Logger } from '@nestjs/common';
import * as client from 'openid-client';
import { OidcSettings } from './oidc.settings';

export const OIDC_SCOPES = 'openid email profile';

export interface OidcAuthorizationRequest {
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface OidcCallbackResult {
  claims: Record<string, unknown>;
  idToken: string;
}

/**
 * The only importer of openid-client. Everything protocol-level (state, PKCE,
 * ID token signature against the JWKS, iss, aud, exp, nonce) is validated by
 * the library here; callers only ever see claims that passed.
 */
export class OidcClient {
  private readonly logger = new Logger(OidcClient.name);
  private discovered: Promise<client.Configuration> | null = null;

  constructor(
    readonly settings: OidcSettings | null,
    private readonly appUrl: string,
  ) {}

  get enabled(): boolean {
    return this.settings !== null;
  }

  get redirectUri(): string {
    return `${this.appUrl}/api/oidc/callback`;
  }

  get postLogoutRedirectUri(): string {
    return `${this.appUrl}/login`;
  }

  async createAuthorizationRequest(): Promise<OidcAuthorizationRequest> {
    const config = await this.configuration();
    const codeVerifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();

    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: this.redirectUri,
      scope: OIDC_SCOPES,
      code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    });

    return { url: url.href, state, nonce, codeVerifier };
  }

  /** `query` is the raw query string the provider redirected back with. */
  async completeAuthorization(
    query: string,
    checks: { state: string; nonce: string; codeVerifier: string },
  ): Promise<OidcCallbackResult> {
    const config = await this.configuration();
    const currentUrl = new URL(this.redirectUri);
    currentUrl.search = query;

    const tokens = await client.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: checks.codeVerifier,
      expectedState: checks.state,
      expectedNonce: checks.nonce,
      idTokenExpected: true,
    });

    const claims = tokens.claims();
    if (!claims || !tokens.id_token) {
      throw new Error('Token response carried no ID token');
    }
    return { claims: { ...claims }, idToken: tokens.id_token };
  }

  /** Null when the provider advertises no end-session endpoint. */
  async buildEndSessionUrl(idToken: string): Promise<string | null> {
    const config = await this.configuration();
    if (!config.serverMetadata().end_session_endpoint) return null;

    return client.buildEndSessionUrl(config, {
      id_token_hint: idToken,
      client_id: this.settings.clientId,
      post_logout_redirect_uri: this.postLogoutRedirectUri,
    }).href;
  }

  // Cached once it succeeds; a failed discovery is retried on the next request.
  private configuration(): Promise<client.Configuration> {
    if (!this.settings) {
      return Promise.reject(new Error('OIDC is not configured'));
    }
    if (!this.discovered) {
      const { issuerUrl, clientId, clientSecret } = this.settings;
      const issuer = new URL(issuerUrl);
      const execute = [client.enableNonRepudiationChecks];
      if (issuer.protocol === 'http:') {
        this.logger.warn(
          'OIDC_ISSUER_URL uses plain http; use https outside local testing',
        );
        execute.push(client.allowInsecureRequests);
      }

      this.discovered = client
        .discovery(issuer, clientId, clientSecret, undefined, { execute })
        .catch((err) => {
          this.discovered = null;
          throw err;
        });
    }
    return this.discovered;
  }
}
