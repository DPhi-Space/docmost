import { UnauthorizedException } from '@nestjs/common';
import { ApiKeyService } from './api-key.service';
import { JwtApiKeyPayload, JwtType } from '../auth/dto/jwt-payload';

describe('ApiKeyService.validateApiKey', () => {
  const workspaceId = 'ws-1';
  const userId = 'user-1';
  const apiKeyId = 'key-1';

  const payload: JwtApiKeyPayload = {
    sub: userId,
    workspaceId,
    apiKeyId,
    type: JwtType.API_KEY,
  };

  const user = { id: userId, workspaceId } as any;
  const workspace = { id: workspaceId } as any;

  function buildService(apiKeyRepo: any, userOverride?: any) {
    const userRepo = {
      findById: jest.fn().mockResolvedValue(userOverride ?? user),
    };
    const workspaceRepo = {
      findById: jest.fn().mockResolvedValue(workspace),
    };
    const tokenService = {} as any;
    const service = new ApiKeyService(
      apiKeyRepo,
      userRepo as any,
      workspaceRepo as any,
      tokenService,
    );
    return { service, userRepo, workspaceRepo };
  }

  const validRow = {
    id: apiKeyId,
    workspaceId,
    creatorId: userId,
    deletedAt: null,
    expiresAt: null,
  };

  it('returns { user, workspace } for a valid key and bumps last_used_at', async () => {
    const apiKeyRepo = {
      findById: jest.fn().mockResolvedValue({ ...validRow }),
      updateLastUsed: jest.fn().mockResolvedValue(undefined),
    };
    const { service } = buildService(apiKeyRepo);

    const result = await service.validateApiKey(payload);

    expect(result).toEqual({ user, workspace });
    expect(apiKeyRepo.updateLastUsed).toHaveBeenCalledWith(apiKeyId);
  });

  it('rejects a missing key', async () => {
    const apiKeyRepo = {
      findById: jest.fn().mockResolvedValue(undefined),
      updateLastUsed: jest.fn(),
    };
    const { service } = buildService(apiKeyRepo);

    await expect(service.validateApiKey(payload)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(apiKeyRepo.updateLastUsed).not.toHaveBeenCalled();
  });

  it('rejects a revoked (soft-deleted) key', async () => {
    const apiKeyRepo = {
      findById: jest
        .fn()
        .mockResolvedValue({ ...validRow, deletedAt: new Date() }),
      updateLastUsed: jest.fn(),
    };
    const { service } = buildService(apiKeyRepo);

    await expect(service.validateApiKey(payload)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(apiKeyRepo.updateLastUsed).not.toHaveBeenCalled();
  });

  it('rejects an expired key', async () => {
    const apiKeyRepo = {
      findById: jest.fn().mockResolvedValue({
        ...validRow,
        expiresAt: new Date(Date.now() - 60_000),
      }),
      updateLastUsed: jest.fn(),
    };
    const { service } = buildService(apiKeyRepo);

    await expect(service.validateApiKey(payload)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(apiKeyRepo.updateLastUsed).not.toHaveBeenCalled();
  });

  it('rejects a key whose workspace does not match the token', async () => {
    const apiKeyRepo = {
      findById: jest
        .fn()
        .mockResolvedValue({ ...validRow, workspaceId: 'other-ws' }),
      updateLastUsed: jest.fn(),
    };
    const { service } = buildService(apiKeyRepo);

    await expect(service.validateApiKey(payload)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(apiKeyRepo.updateLastUsed).not.toHaveBeenCalled();
  });

  it('rejects a deactivated user', async () => {
    const apiKeyRepo = {
      findById: jest.fn().mockResolvedValue({ ...validRow }),
      updateLastUsed: jest.fn(),
    };
    const { service } = buildService(apiKeyRepo, {
      id: userId,
      workspaceId,
      deactivatedAt: new Date(),
    });

    await expect(service.validateApiKey(payload)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(apiKeyRepo.updateLastUsed).not.toHaveBeenCalled();
  });
});
