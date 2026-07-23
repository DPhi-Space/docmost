import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiKeyRepo } from '@docmost/db/repos/api-key/api-key.repo';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { TokenService } from '../auth/services/token.service';
import { JwtApiKeyPayload } from '../auth/dto/jwt-payload';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { isUserDisabled } from '../../common/helpers';
import { CreateApiKeyDto } from './dto/api-key.dto';

@Injectable()
export class ApiKeyService {
  constructor(
    private readonly apiKeyRepo: ApiKeyRepo,
    private readonly userRepo: UserRepo,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly tokenService: TokenService,
  ) {}

  async create(opts: {
    user: User;
    workspaceId: string;
    dto: CreateApiKeyDto;
  }) {
    const { user, workspaceId, dto } = opts;

    let expiresAt: Date | null = null;
    let expiresIn: number | undefined;

    if (dto.expiresAt) {
      expiresAt = new Date(dto.expiresAt);
      const seconds = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
      if (Number.isNaN(seconds) || seconds <= 0) {
        throw new BadRequestException('expiresAt must be a future date');
      }
      expiresIn = seconds;
    }

    const apiKey = await this.apiKeyRepo.insertApiKey({
      name: dto.name,
      creatorId: user.id,
      workspaceId,
      expiresAt,
    });

    // The API key is a self-contained JWT signed with the app secret. It is
    // returned exactly once here; the DB row only stores metadata + revocation.
    const token = await this.tokenService.generateApiToken({
      apiKeyId: apiKey.id,
      user,
      workspaceId,
      expiresIn,
    });

    return { ...apiKey, token };
  }

  async getApiKeys(
    workspaceId: string,
    pagination: PaginationOptions,
    opts?: { userId?: string },
  ) {
    return this.apiKeyRepo.getApiKeys(workspaceId, pagination, opts);
  }

  async updateApiKey(apiKeyId: string, workspaceId: string, name: string) {
    return this.apiKeyRepo.updateApiKey({ name }, apiKeyId, workspaceId);
  }

  async revokeApiKey(apiKeyId: string, workspaceId: string): Promise<void> {
    await this.apiKeyRepo.softDelete(apiKeyId, workspaceId);
  }

  /**
   * Resolves an API-key JWT payload into the authenticated principal.
   * Mirrors the contract that jwt.strategy expects for access tokens:
   * it returns `{ user, workspace }` on success, or throws Unauthorized.
   */
  async validateApiKey(
    payload: JwtApiKeyPayload,
  ): Promise<{ user: User; workspace: Workspace }> {
    const apiKey = await this.apiKeyRepo.findById(payload.apiKeyId);

    // Missing or revoked (soft-deleted) keys are rejected.
    if (!apiKey || apiKey.deletedAt) {
      throw new UnauthorizedException('Invalid API key');
    }

    // Every key is scoped to the workspace it was minted in.
    if (apiKey.workspaceId !== payload.workspaceId) {
      throw new UnauthorizedException('Invalid API key');
    }

    // Enforce row-level expiry in addition to the JWT `exp` claim.
    if (apiKey.expiresAt && new Date(apiKey.expiresAt).getTime() <= Date.now()) {
      throw new UnauthorizedException('API key has expired');
    }

    const workspace = await this.workspaceRepo.findById(payload.workspaceId);
    if (!workspace) {
      throw new UnauthorizedException('Invalid API key');
    }

    const user = await this.userRepo.findById(payload.sub, payload.workspaceId);
    if (!user || isUserDisabled(user)) {
      throw new UnauthorizedException('Invalid API key');
    }

    await this.apiKeyRepo.updateLastUsed(apiKey.id);

    return { user, workspace };
  }
}
