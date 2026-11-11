jest.mock('../../session/session-activity.service', () => ({
  SessionActivityService: class SessionActivityService {},
}));
jest.mock('../../api-key/api-key.service', () => ({
  ApiKeyService: class ApiKeyService {},
}));

import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';
import { JwtType } from '../dto/jwt-payload';
import { ApiKeyService } from '../../api-key/api-key.service';

// Offboarding: deactivating the Docmost user must cut every credential they
// hold, whichever way they signed in.
describe('JwtStrategy.validate', () => {
  const workspace = { id: 'ws-1' };
  const activeUser = {
    id: 'user-1',
    workspaceId: 'ws-1',
    deactivatedAt: null,
    deletedAt: null,
  };
  const deactivatedUser = { ...activeUser, deactivatedAt: new Date() };

  function build(user: unknown) {
    const apiKeyService = {
      validateApiKey: jest
        .fn()
        .mockRejectedValue(new UnauthorizedException('Invalid API key')),
    };
    const moduleRef = {
      get: jest.fn((token) =>
        token === ApiKeyService ? apiKeyService : undefined,
      ),
    };
    const strategy = new JwtStrategy(
      { findById: jest.fn().mockResolvedValue(user) } as any,
      { findById: jest.fn().mockResolvedValue(workspace) } as any,
      {
        findActiveById: jest
          .fn()
          .mockResolvedValue({
            id: 'session-1',
            userId: 'user-1',
            workspaceId: 'ws-1',
          }),
      } as any,
      { trackActivity: jest.fn() } as any,
      { getAppSecret: () => 'x'.repeat(64) } as any,
      moduleRef as any,
    );
    return { strategy, apiKeyService };
  }

  const req = () => ({ raw: { workspaceId: 'ws-1' } });

  it('accepts an active user session', async () => {
    const { strategy } = build(activeUser);
    await expect(
      strategy.validate(req(), {
        sub: 'user-1',
        workspaceId: 'ws-1',
        type: JwtType.ACCESS,
        sessionId: 'session-1',
      } as any),
    ).resolves.toMatchObject({ user: activeUser, authType: JwtType.ACCESS });
  });

  it('rejects a session of a deactivated user (password or OIDC alike)', async () => {
    const { strategy } = build(deactivatedUser);
    await expect(
      strategy.validate(req(), {
        sub: 'user-1',
        workspaceId: 'ws-1',
        type: JwtType.ACCESS,
        sessionId: 'session-1',
      } as any),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('routes API keys (and so the MCP server) through ApiKeyService, which rejects deactivated users', async () => {
    const { strategy, apiKeyService } = build(deactivatedUser);
    await expect(
      strategy.validate(req(), {
        sub: 'user-1',
        workspaceId: 'ws-1',
        type: JwtType.API_KEY,
        apiKeyId: 'key-1',
      } as any),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(apiKeyService.validateApiKey).toHaveBeenCalled();
  });

  it('rejects OAuth access tokens, whose validator ships only with the EE module', async () => {
    const { strategy } = build(activeUser);
    await expect(
      strategy.validate(req(), {
        sub: 'user-1',
        workspaceId: 'ws-1',
        type: JwtType.OAUTH_ACCESS,
      } as any),
    ).rejects.toThrow('Enterprise OAuth module missing');
  });
});
