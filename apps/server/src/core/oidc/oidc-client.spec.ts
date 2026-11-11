// openid-client is ESM-only and Jest does not transform node_modules. Node can
// require() ESM natively, so load the real library through Node's own loader
// instead of Jest's (createRequire from 'node:module' is intercepted by Jest).
jest.mock('openid-client', () =>
  (process as any).getBuiltinModule('node:module').createRequire(__filename)(
    'openid-client',
  ),
);

import { createHash, generateKeyPairSync, KeyObject, sign } from 'node:crypto';
import { createServer, IncomingMessage, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { OidcClient } from './oidc-client';

const CLIENT_ID = 'docmost';
const CLIENT_SECRET = 'client-secret';
const APP_URL = 'http://docmost.test';

const signingKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 });

function b64url(input: Buffer | string) {
  return Buffer.from(input).toString('base64url');
}

function signJwt(claims: Record<string, unknown>, key: KeyObject) {
  const header = b64url(
    JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'k1' }),
  );
  const payload = b64url(JSON.stringify(claims));
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), key);
  return `${header}.${payload}.${b64url(signature)}`;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
  });
}

/** A minimal issuer: discovery, JWKS and a token endpoint that enforces PKCE. */
class FakeIssuer {
  server: Server;
  issuer: string;
  codeChallenge: string;
  idTokenClaims: (base: Record<string, unknown>) => Record<string, unknown> = (
    base,
  ) => base;
  idTokenKey: KeyObject = signingKey.privateKey;
  nonce: string;
  tokenRequests: URLSearchParams[] = [];

  async start() {
    this.server = createServer(async (req, res) => {
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const url = new URL(req.url, this.issuer);

      if (url.pathname === '/.well-known/openid-configuration') {
        return json(200, {
          issuer: this.issuer,
          authorization_endpoint: `${this.issuer}/authorize`,
          token_endpoint: `${this.issuer}/token`,
          jwks_uri: `${this.issuer}/jwks`,
          end_session_endpoint: `${this.issuer}/logout`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
        });
      }
      if (url.pathname === '/jwks') {
        const jwk = signingKey.publicKey.export({ format: 'jwk' });
        return json(200, {
          keys: [{ ...jwk, kid: 'k1', alg: 'RS256', use: 'sig' }],
        });
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        const params = new URLSearchParams(await readBody(req));
        this.tokenRequests.push(params);
        const verifier = params.get('code_verifier') ?? '';
        const challenge = createHash('sha256')
          .update(verifier)
          .digest('base64url');
        if (
          params.get('code') !== 'good-code' ||
          challenge !== this.codeChallenge
        ) {
          return json(400, { error: 'invalid_grant' });
        }
        const now = Math.floor(Date.now() / 1000);
        const claims = this.idTokenClaims({
          iss: this.issuer,
          aud: CLIENT_ID,
          sub: 'user-sub-1',
          nonce: this.nonce,
          iat: now,
          exp: now + 300,
          email: 'alice@example.com',
          email_verified: true,
          roles: ['user'],
        });
        return json(200, {
          access_token: 'access-token',
          token_type: 'Bearer',
          expires_in: 300,
          id_token: signJwt(claims, this.idTokenKey),
        });
      }
      json(404, {});
    });

    await new Promise<void>((resolve) =>
      this.server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = this.server.address() as AddressInfo;
    this.issuer = `http://127.0.0.1:${port}`;
  }

  stop() {
    return new Promise((resolve) => this.server.close(resolve));
  }
}

/** The library's own reason, which sits on the cause of its wrapper error. */
async function failureOf(promise: Promise<unknown>): Promise<string> {
  const err: any = await promise.then(
    () => null,
    (e) => e,
  );
  if (!err) throw new Error('expected the promise to reject');
  return `${err.message} | ${err.cause?.message ?? ''}`;
}

describe('OidcClient against a real openid-client and a fake issuer', () => {
  let issuer: FakeIssuer;

  beforeAll(async () => {
    issuer = new FakeIssuer();
    await issuer.start();
  });

  afterAll(() => issuer.stop());

  beforeEach(() => {
    issuer.idTokenClaims = (base) => base;
    issuer.idTokenKey = signingKey.privateKey;
    issuer.tokenRequests = [];
  });

  function newClient() {
    return new OidcClient(
      {
        issuerUrl: issuer.issuer,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        requiredRole: null,
      },
      APP_URL,
    );
  }

  async function startFlow(client: OidcClient) {
    const request = await client.createAuthorizationRequest();
    const url = new URL(request.url);
    issuer.codeChallenge = url.searchParams.get('code_challenge');
    issuer.nonce = url.searchParams.get('nonce');
    return { request, url };
  }

  it('builds an authorization request with PKCE S256, state, nonce and the callback URI', async () => {
    const { request, url } = await startFlow(newClient());

    expect(url.origin + url.pathname).toBe(`${issuer.issuer}/authorize`);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(
      `${APP_URL}/api/oidc/callback`,
    );
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe(request.state);
    expect(url.searchParams.get('nonce')).toBe(request.nonce);
    expect(url.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(request.codeVerifier).digest('base64url'),
    );
  });

  it('exchanges the code and returns the validated claims and raw ID token', async () => {
    const client = newClient();
    const { request } = await startFlow(client);

    const result = await client.completeAuthorization(
      `?code=good-code&state=${request.state}`,
      request,
    );

    expect(result.claims).toMatchObject({
      sub: 'user-sub-1',
      email: 'alice@example.com',
      email_verified: true,
      roles: ['user'],
    });
    expect(result.idToken.split('.')).toHaveLength(3);
    expect(issuer.tokenRequests[0].get('redirect_uri')).toBe(
      `${APP_URL}/api/oidc/callback`,
    );
  });

  it('rejects an ID token issued for another audience', async () => {
    const client = newClient();
    const { request } = await startFlow(client);
    issuer.idTokenClaims = (base) => ({ ...base, aud: 'some-other-client' });

    expect(
      await failureOf(
        client.completeAuthorization(
          `?code=good-code&state=${request.state}`,
          request,
        ),
      ),
    ).toContain('"aud"');
  });

  it('rejects an ID token with the wrong nonce', async () => {
    const client = newClient();
    const { request } = await startFlow(client);
    issuer.idTokenClaims = (base) => ({ ...base, nonce: 'replayed-nonce' });

    expect(
      await failureOf(
        client.completeAuthorization(
          `?code=good-code&state=${request.state}`,
          request,
        ),
      ),
    ).toContain('"nonce"');
  });

  it('rejects an ID token from another issuer', async () => {
    const client = newClient();
    const { request } = await startFlow(client);
    issuer.idTokenClaims = (base) => ({ ...base, iss: 'https://evil.example' });

    expect(
      await failureOf(
        client.completeAuthorization(
          `?code=good-code&state=${request.state}`,
          request,
        ),
      ),
    ).toContain('"iss"');
  });

  it('rejects an ID token whose signature does not verify against the JWKS', async () => {
    const client = newClient();
    const { request } = await startFlow(client);
    issuer.idTokenKey = otherKey.privateKey;

    expect(
      await failureOf(
        client.completeAuthorization(
          `?code=good-code&state=${request.state}`,
          request,
        ),
      ),
    ).toContain('signature verification failed');
  });

  it('rejects an expired ID token', async () => {
    const client = newClient();
    const { request } = await startFlow(client);
    issuer.idTokenClaims = (base) => ({
      ...base,
      iat: Math.floor(Date.now() / 1000) - 3600,
      exp: Math.floor(Date.now() / 1000) - 1800,
    });

    expect(
      await failureOf(
        client.completeAuthorization(
          `?code=good-code&state=${request.state}`,
          request,
        ),
      ),
    ).toContain('"exp"');
  });

  it('rejects a callback whose state does not match, before calling the token endpoint', async () => {
    const client = newClient();
    const { request } = await startFlow(client);

    expect(
      await failureOf(
        client.completeAuthorization('?code=good-code&state=forged', request),
      ),
    ).toContain('"state"');
    expect(issuer.tokenRequests).toHaveLength(0);
  });

  it('fails the exchange when the PKCE verifier does not match', async () => {
    const client = newClient();
    const { request } = await startFlow(client);

    await expect(
      client.completeAuthorization(`?code=good-code&state=${request.state}`, {
        ...request,
        codeVerifier: 'x'.repeat(43),
      }),
    ).rejects.toThrow();
  });

  it('reports a provider error response as a failure', async () => {
    const client = newClient();
    const { request } = await startFlow(client);

    await expect(
      client.completeAuthorization(
        `?error=access_denied&state=${request.state}`,
        request,
      ),
    ).rejects.toThrow();
    expect(issuer.tokenRequests).toHaveLength(0);
  });

  it('builds the end-session URL with id_token_hint and the login page as post-logout target', async () => {
    const url = new URL(await newClient().buildEndSessionUrl('the-id-token'));

    expect(url.origin + url.pathname).toBe(`${issuer.issuer}/logout`);
    expect(url.searchParams.get('id_token_hint')).toBe('the-id-token');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe(
      `${APP_URL}/login`,
    );
  });

  it('retries discovery after a failure instead of caching it', async () => {
    const client = new OidcClient(
      {
        issuerUrl: 'http://127.0.0.1:1',
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        requiredRole: null,
      },
      APP_URL,
    );
    await expect(client.createAuthorizationRequest()).rejects.toThrow();
    (client as any).settings = { ...client.settings, issuerUrl: issuer.issuer };
    await expect(client.createAuthorizationRequest()).resolves.toHaveProperty(
      'url',
    );
  });

  it('refuses to work when not configured', async () => {
    const client = new OidcClient(null, APP_URL);
    expect(client.enabled).toBe(false);
    await expect(client.createAuthorizationRequest()).rejects.toThrow(
      'OIDC is not configured',
    );
  });
});
