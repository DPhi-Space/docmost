jest.mock('./oidc-client', () => ({ OidcClient: class OidcClient {} }));
jest.mock('../session/session.service', () => ({
  SessionService: class SessionService {},
}));

import { OidcController, OIDC_LOGIN_ERROR_REDIRECT } from './oidc.controller';
import { OidcSignInRefused } from './oidc-account.service';
import {
  decodeFlowState,
  encodeFlowState,
  OIDC_ID_TOKEN_COOKIE,
  OIDC_STATE_COOKIE,
} from './oidc-state';
import { AuditEvent } from '../../common/events/audit-events';
import { validateSsoEnforcement } from '../auth/auth.util';

const APP_SECRET = 'a'.repeat(64);
const APP_URL = 'https://docs.example.com';

const workspace = { id: 'ws-1', enforceSso: false, emailDomains: [] } as any;
const user = { id: 'user-1', workspaceId: 'ws-1' } as any;

function validFlow(overrides: Record<string, unknown> = {}) {
  return encodeFlowState(
    {
      state: 'the-state',
      nonce: 'the-nonce',
      codeVerifier: 'the-verifier',
      redirect: '/s/general/p/page-1',
      exp: Date.now() + 60_000,
      ...overrides,
    } as any,
    APP_SECRET,
  );
}

function setup(opts: { enabled?: boolean; requiredRole?: string | null } = {}) {
  const enabled = opts.enabled ?? true;
  const oidcClient = {
    enabled,
    settings: enabled ? { requiredRole: opts.requiredRole ?? null } : null,
    createAuthorizationRequest: jest.fn().mockResolvedValue({
      url: 'https://idp.example/authorize?x=1',
      state: 'the-state',
      nonce: 'the-nonce',
      codeVerifier: 'the-verifier',
    }),
    completeAuthorization: jest.fn().mockResolvedValue({
      claims: {
        sub: 'sub-alice',
        email: 'alice@example.com',
        email_verified: true,
        roles: ['user'],
      },
      idToken: 'raw.id.token',
    }),
    buildEndSessionUrl: jest
      .fn()
      .mockResolvedValue(
        'https://idp.example/logout?id_token_hint=raw.id.token',
      ),
  };
  const oidcAccountService = { resolveUser: jest.fn().mockResolvedValue(user) };
  const sessionService = {
    createSessionAndToken: jest.fn().mockResolvedValue('session-jwt'),
  };
  const userRepo = { updateLastLogin: jest.fn().mockResolvedValue(undefined) };
  const environmentService = {
    getAppSecret: () => APP_SECRET,
    getAppUrl: () => APP_URL,
    isHttps: () => true,
    getCookieExpiresIn: () => new Date(Date.now() + 12 * 3600_000),
  };
  const auditService = { log: jest.fn() };

  const controller = new OidcController(
    oidcClient as any,
    oidcAccountService as any,
    sessionService as any,
    userRepo as any,
    environmentService as any,
    auditService as any,
  );

  return {
    controller,
    oidcClient,
    oidcAccountService,
    sessionService,
    userRepo,
    auditService,
  };
}

function request(opts: {
  url?: string;
  cookies?: Record<string, string>;
  workspace?: unknown;
}) {
  return {
    url: opts.url ?? '/api/oidc/callback?code=c&state=the-state',
    headers: {},
    cookies: opts.cookies ?? {},
    raw: { workspace: 'workspace' in opts ? opts.workspace : workspace },
  } as any;
}

function reply() {
  return {
    redirect: jest.fn().mockReturnThis(),
    setCookie: jest.fn().mockReturnThis(),
    clearCookie: jest.fn().mockReturnThis(),
  } as any;
}

describe('OidcController', () => {
  describe('GET /oidc/login', () => {
    it('stores state, nonce, verifier and a safe redirect in a signed cookie, then redirects to the provider', async () => {
      const { controller } = setup();
      const res = reply();

      await controller.login('/s/general/p/page-1', request({}), res);

      expect(res.redirect).toHaveBeenCalledWith(
        'https://idp.example/authorize?x=1',
        302,
      );
      const [name, value, options] = res.setCookie.mock.calls[0];
      expect(name).toBe(OIDC_STATE_COOKIE);
      expect(options).toMatchObject({
        httpOnly: true,
        sameSite: 'lax',
        path: '/api/oidc',
        secure: true,
      });
      expect(options.expires.getTime() - Date.now()).toBeLessThanOrEqual(
        10 * 60_000,
      );
      expect(decodeFlowState(value, APP_SECRET)).toMatchObject({
        state: 'the-state',
        nonce: 'the-nonce',
        codeVerifier: 'the-verifier',
        redirect: '/s/general/p/page-1',
      });
    });

    it.each([
      'https://evil.example/x',
      '//evil.example/x',
      '/\\evil.example',
      'javascript:alert(1)',
      '/.//evil.com',
      '/%2e//evil.com/login',
      '/a/..//evil.com',
    ])('drops an unsafe redirect (%s)', async (redirect) => {
      const { controller } = setup();
      const res = reply();

      await controller.login(redirect, request({}), res);

      const flow = decodeFlowState(res.setCookie.mock.calls[0][1], APP_SECRET);
      expect(flow.redirect).toBeNull();
    });

    it('is inert when OIDC is not configured', async () => {
      const { controller, oidcClient } = setup({ enabled: false });
      const res = reply();

      await controller.login(undefined, request({}), res);

      expect(res.redirect).toHaveBeenCalledWith('/login', 302);
      expect(res.setCookie).not.toHaveBeenCalled();
      expect(oidcClient.createAuthorizationRequest).not.toHaveBeenCalled();
    });

    it('lands on the login error when the provider cannot be reached', async () => {
      const { controller, oidcClient } = setup();
      oidcClient.createAuthorizationRequest.mockRejectedValue(
        new Error('fetch failed'),
      );
      const res = reply();

      await controller.login(undefined, request({}), res);

      expect(res.redirect).toHaveBeenCalledWith(OIDC_LOGIN_ERROR_REDIRECT, 302);
    });
  });

  describe('GET /oidc/callback', () => {
    it('issues a session through the password-login path and sets both cookies', async () => {
      const {
        controller,
        oidcClient,
        oidcAccountService,
        sessionService,
        userRepo,
        auditService,
      } = setup();
      const res = reply();

      await controller.callback(
        request({ cookies: { [OIDC_STATE_COOKIE]: validFlow() } }),
        res,
      );

      expect(oidcClient.completeAuthorization).toHaveBeenCalledWith(
        '?code=c&state=the-state',
        expect.objectContaining({
          state: 'the-state',
          nonce: 'the-nonce',
          codeVerifier: 'the-verifier',
        }),
      );
      expect(oidcAccountService.resolveUser).toHaveBeenCalledWith(
        workspace,
        expect.objectContaining({ sub: 'sub-alice', emailVerified: true }),
      );
      expect(sessionService.createSessionAndToken).toHaveBeenCalledWith(user);
      expect(userRepo.updateLastLogin).toHaveBeenCalledWith('user-1', 'ws-1');
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: AuditEvent.USER_LOGIN,
          resourceId: 'user-1',
          metadata: { source: 'oidc' },
        }),
      );
      expect(res.setCookie).toHaveBeenCalledWith(
        'authToken',
        'session-jwt',
        expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/' }),
      );
      expect(res.setCookie).toHaveBeenCalledWith(
        OIDC_ID_TOKEN_COOKIE,
        'raw.id.token',
        expect.objectContaining({ httpOnly: true, path: '/api/oidc' }),
      );
      expect(res.clearCookie).toHaveBeenCalledWith(OIDC_STATE_COOKIE, {
        path: '/api/oidc',
      });
      expect(res.redirect).toHaveBeenCalledWith('/s/general/p/page-1', 302);
    });

    it('lands on /home when no redirect was saved', async () => {
      const { controller } = setup();
      const res = reply();

      await controller.callback(
        request({
          cookies: { [OIDC_STATE_COOKIE]: validFlow({ redirect: null }) },
        }),
        res,
      );

      expect(res.redirect).toHaveBeenCalledWith('/home', 302);
    });

    it.each(['//evil.com', '/.//evil.com', '/a/..//evil.com'])(
      'never redirects off-site from the callback, even for a signed %p',
      async (redirect) => {
        const { controller } = setup();
        const res = reply();

        await controller.callback(
          request({
            cookies: { [OIDC_STATE_COOKIE]: validFlow({ redirect }) },
          }),
          res,
        );

        expect(res.redirect).toHaveBeenCalledWith('/home', 302);
      },
    );

    it.each([
      ['missing', undefined],
      ['tampered', validFlow().replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))],
      [
        'signed with another secret',
        encodeFlowState(
          {
            state: 'the-state',
            nonce: 'the-nonce',
            codeVerifier: 'the-verifier',
            redirect: null,
            exp: Date.now() + 60_000,
          },
          'b'.repeat(64),
        ),
      ],
      ['expired', validFlow({ exp: Date.now() - 1 })],
    ])(
      'refuses a %s state cookie without contacting the provider',
      async (_label, cookie) => {
        const { controller, oidcClient, sessionService } = setup();
        const res = reply();

        await controller.callback(
          request({ cookies: cookie ? { [OIDC_STATE_COOKIE]: cookie } : {} }),
          res,
        );

        expect(oidcClient.completeAuthorization).not.toHaveBeenCalled();
        expect(sessionService.createSessionAndToken).not.toHaveBeenCalled();
        expect(res.setCookie).not.toHaveBeenCalled();
        expect(res.clearCookie).toHaveBeenCalledWith(OIDC_STATE_COOKIE, {
          path: '/api/oidc',
        });
        expect(res.redirect).toHaveBeenCalledWith(
          OIDC_LOGIN_ERROR_REDIRECT,
          302,
        );
      },
    );

    it('refuses when the provider exchange fails (wrong state, aud, nonce, signature)', async () => {
      const { controller, oidcClient, sessionService } = setup();
      oidcClient.completeAuthorization.mockRejectedValue(
        new Error('unexpected JWT claim value encountered'),
      );
      const res = reply();

      await controller.callback(
        request({ cookies: { [OIDC_STATE_COOKIE]: validFlow() } }),
        res,
      );

      expect(sessionService.createSessionAndToken).not.toHaveBeenCalled();
      expect(res.setCookie).not.toHaveBeenCalled();
      expect(res.redirect).toHaveBeenCalledWith(OIDC_LOGIN_ERROR_REDIRECT, 302);
    });

    it('refuses a token without the required role', async () => {
      const { controller, oidcClient, oidcAccountService, sessionService } =
        setup({
          requiredRole: 'docmost-user',
        });
      oidcClient.completeAuthorization.mockResolvedValue({
        claims: {
          sub: 'sub-alice',
          email: 'alice@example.com',
          email_verified: true,
        },
        idToken: 'raw.id.token',
      });
      const res = reply();

      await controller.callback(
        request({ cookies: { [OIDC_STATE_COOKIE]: validFlow() } }),
        res,
      );

      expect(oidcAccountService.resolveUser).not.toHaveBeenCalled();
      expect(sessionService.createSessionAndToken).not.toHaveBeenCalled();
      expect(res.redirect).toHaveBeenCalledWith(OIDC_LOGIN_ERROR_REDIRECT, 302);
    });

    it('refuses when account resolution refuses (disabled user, ambiguous email, ...)', async () => {
      const { controller, oidcAccountService, sessionService } = setup();
      oidcAccountService.resolveUser.mockRejectedValue(
        new OidcSignInRefused('user user-1 is disabled'),
      );
      const res = reply();

      await controller.callback(
        request({ cookies: { [OIDC_STATE_COOKIE]: validFlow() } }),
        res,
      );

      expect(sessionService.createSessionAndToken).not.toHaveBeenCalled();
      expect(res.redirect).toHaveBeenCalledWith(OIDC_LOGIN_ERROR_REDIRECT, 302);
    });

    it('is inert when OIDC is not configured', async () => {
      const { controller, oidcClient } = setup({ enabled: false });
      const res = reply();

      await controller.callback(
        request({ cookies: { [OIDC_STATE_COOKIE]: validFlow() } }),
        res,
      );

      expect(oidcClient.completeAuthorization).not.toHaveBeenCalled();
      expect(res.redirect).toHaveBeenCalledWith(OIDC_LOGIN_ERROR_REDIRECT, 302);
    });
  });

  describe('enforce_sso', () => {
    const enforced = { ...workspace, enforceSso: true };

    it('blocks the password path', () => {
      expect(() => validateSsoEnforcement(enforced)).toThrow(
        'This workspace has enforced SSO login.',
      );
    });

    it('still lets the OIDC callback issue a session', async () => {
      const { controller, sessionService } = setup();
      const res = reply();

      await controller.callback(
        request({
          cookies: { [OIDC_STATE_COOKIE]: validFlow() },
          workspace: enforced,
        }),
        res,
      );

      expect(sessionService.createSessionAndToken).toHaveBeenCalledWith(user);
      expect(res.setCookie).toHaveBeenCalledWith(
        'authToken',
        'session-jwt',
        expect.anything(),
      );
      expect(res.redirect).toHaveBeenCalledWith('/s/general/p/page-1', 302);
    });
  });

  describe('GET /oidc/logout', () => {
    it('clears the ID token cookie and redirects to the provider end-session URL', async () => {
      const { controller, oidcClient } = setup();
      const res = reply();

      await controller.logout(
        request({ cookies: { [OIDC_ID_TOKEN_COOKIE]: 'raw.id.token' } }),
        res,
      );

      expect(oidcClient.buildEndSessionUrl).toHaveBeenCalledWith(
        'raw.id.token',
      );
      expect(res.clearCookie).toHaveBeenCalledWith(OIDC_ID_TOKEN_COOKIE, {
        path: '/api/oidc',
      });
      expect(res.redirect).toHaveBeenCalledWith(
        'https://idp.example/logout?id_token_hint=raw.id.token',
        302,
      );
    });

    it.each(['cross-site', 'same-site', 'none'])(
      'ignores a %s navigation: keeps the ID token and does not reach the provider',
      async (site) => {
        const { controller, oidcClient } = setup();
        const res = reply();
        const req = request({
          cookies: { [OIDC_ID_TOKEN_COOKIE]: 'raw.id.token' },
        });
        req.headers = { 'sec-fetch-site': site };

        await controller.logout(req, res);

        expect(oidcClient.buildEndSessionUrl).not.toHaveBeenCalled();
        expect(res.clearCookie).not.toHaveBeenCalled();
        expect(res.redirect).toHaveBeenCalledWith('/login?logout=1', 302);
      },
    );

    it('ends the provider session for a same-origin navigation', async () => {
      const { controller, oidcClient } = setup();
      const res = reply();
      const req = request({
        cookies: { [OIDC_ID_TOKEN_COOKIE]: 'raw.id.token' },
      });
      req.headers = { 'sec-fetch-site': 'same-origin' };

      await controller.logout(req, res);

      expect(oidcClient.buildEndSessionUrl).toHaveBeenCalledWith(
        'raw.id.token',
      );
    });

    it('falls back to the login page without an ID token', async () => {
      const { controller, oidcClient } = setup();
      const res = reply();

      await controller.logout(request({}), res);

      expect(oidcClient.buildEndSessionUrl).not.toHaveBeenCalled();
      expect(res.redirect).toHaveBeenCalledWith('/login?logout=1', 302);
    });

    it('falls back to the login page when the provider has no end-session endpoint', async () => {
      const { controller, oidcClient } = setup();
      oidcClient.buildEndSessionUrl.mockResolvedValue(null);
      const res = reply();

      await controller.logout(
        request({ cookies: { [OIDC_ID_TOKEN_COOKIE]: 'raw.id.token' } }),
        res,
      );

      expect(res.redirect).toHaveBeenCalledWith('/login?logout=1', 302);
    });

    it('is inert when OIDC is not configured', async () => {
      const { controller, oidcClient } = setup({ enabled: false });
      const res = reply();

      await controller.logout(
        request({ cookies: { [OIDC_ID_TOKEN_COOKIE]: 'raw.id.token' } }),
        res,
      );

      expect(oidcClient.buildEndSessionUrl).not.toHaveBeenCalled();
      expect(res.redirect).toHaveBeenCalledWith('/login?logout=1', 302);
    });
  });
});
