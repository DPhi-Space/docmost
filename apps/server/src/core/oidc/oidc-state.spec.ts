import {
  decodeFlowState,
  encodeFlowState,
  safeRedirectPath,
} from './oidc-state';
import { isOidcEnabled, readOidcSettings } from './oidc.settings';
import { redactSensitiveUrl } from '../../common/helpers/utils';

const SECRET = 's'.repeat(64);
const APP_URL = 'https://docs.example.com';

describe('OIDC flow state cookie', () => {
  const flow = {
    state: 'st',
    nonce: 'no',
    codeVerifier: 'cv',
    redirect: '/home',
    exp: Date.now() + 60_000,
  };

  it('round-trips', () => {
    expect(decodeFlowState(encodeFlowState(flow, SECRET), SECRET)).toEqual(
      flow,
    );
  });

  it('rejects a modified payload', () => {
    const cookie = encodeFlowState(flow, SECRET);
    const [, signature] = cookie.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...flow, redirect: '/settings' }),
    ).toString('base64url');
    expect(decodeFlowState(`${forged}.${signature}`, SECRET)).toBeNull();
  });

  it('rejects another secret, expiry, garbage and absence', () => {
    expect(
      decodeFlowState(encodeFlowState(flow, SECRET), 'x'.repeat(64)),
    ).toBeNull();
    expect(
      decodeFlowState(
        encodeFlowState({ ...flow, exp: Date.now() - 1 }, SECRET),
        SECRET,
      ),
    ).toBeNull();
    expect(decodeFlowState('not-a-cookie', SECRET)).toBeNull();
    expect(decodeFlowState('.abc', SECRET)).toBeNull();
    expect(decodeFlowState(undefined, SECRET)).toBeNull();
  });
});

describe('safeRedirectPath (server copy of the client rules)', () => {
  it.each([
    ['/home', '/home'],
    ['/s/general/p/page-1?x=1#h', '/s/general/p/page-1?x=1#h'],
  ])('keeps %s', (input, expected) => {
    expect(safeRedirectPath(input, APP_URL)).toBe(expected);
  });

  it.each([
    undefined,
    '',
    'home',
    '//evil.example',
    '/\\evil.example',
    'https://evil.example',
    '/redirect?to=https://evil.example',
    '/javascript:alert(1)',
    '/ home',
    '/​home',
    '/api/oidc/logout',
    '/api',
    '/.//evil.com',
    '/%2e//evil.com/login',
    '/a/..//evil.com',
    '/' + 'a'.repeat(2048),
  ])('drops %p', (input) => {
    expect(safeRedirectPath(input, APP_URL)).toBeNull();
  });
});

describe('OIDC settings', () => {
  const env = {
    OIDC_ISSUER_URL: 'https://sso.example.com/realms/corp',
    OIDC_CLIENT_ID: 'docmost',
    OIDC_CLIENT_SECRET: 'secret',
  };

  it('is off without an issuer, so upstream behaviour is unchanged', () => {
    expect(readOidcSettings({})).toBeNull();
    expect(isOidcEnabled({ ...env, OIDC_ISSUER_URL: '' })).toBe(false);
  });

  it('is on with issuer, client id and secret', () => {
    expect(readOidcSettings(env)).toEqual({
      issuerUrl: env.OIDC_ISSUER_URL,
      clientId: 'docmost',
      clientSecret: 'secret',
      requiredRole: null,
    });
    expect(
      readOidcSettings({ ...env, OIDC_REQUIRED_ROLE: 'user' }).requiredRole,
    ).toBe('user');
  });

  it('stays off when the client credentials are incomplete', () => {
    expect(isOidcEnabled({ ...env, OIDC_CLIENT_SECRET: '' })).toBe(false);
    expect(isOidcEnabled({ ...env, OIDC_CLIENT_ID: undefined })).toBe(false);
  });

  it('stays off in cloud mode', () => {
    expect(isOidcEnabled({ ...env, CLOUD: 'true' })).toBe(false);
  });
});

describe('request log redaction', () => {
  it('drops the code and state of the OIDC callback from logged URLs', () => {
    expect(redactSensitiveUrl('/api/oidc/callback?code=abc&state=def')).toBe(
      '/api/oidc/callback',
    );
  });

  it('leaves unrelated URLs alone', () => {
    expect(redactSensitiveUrl('/api/pages/info?id=1')).toBe(
      '/api/pages/info?id=1',
    );
  });
});
