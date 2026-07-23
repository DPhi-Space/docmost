import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { ApiKeyService } from './api-key.service';
import { ApiKeyRepo } from '@docmost/db/repos/api-key/api-key.repo';
import WorkspaceAbilityFactory from '../casl/abilities/workspace-ability.factory';
import {
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../casl/interfaces/workspace-ability.type';
import {
  CreateApiKeyDto,
  RevokeApiKeyDto,
  UpdateApiKeyDto,
} from './dto/api-key.dto';

@UseGuards(JwtAuthGuard)
@Controller('api-keys')
export class ApiKeyController {
  constructor(
    private readonly apiKeyService: ApiKeyService,
    private readonly apiKeyRepo: ApiKeyRepo,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('/')
  async list(
    @Body() pagination: PaginationOptions,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    // `adminView` lists every key in the workspace and requires admin rights.
    if (pagination.adminView) {
      if (!this.canManage(user, workspace)) {
        throw new ForbiddenException();
      }
      return this.apiKeyService.getApiKeys(workspace.id, pagination);
    }

    // Personal listing is scoped to the requesting user.
    return this.apiKeyService.getApiKeys(workspace.id, pagination, {
      userId: user.id,
    });
  }

  @HttpCode(HttpStatus.OK)
  @Post('create')
  async create(
    @Body() dto: CreateApiKeyDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const restrictToAdmins =
      (workspace.settings as any)?.api?.restrictToAdmins === true;

    if (restrictToAdmins && !this.canManage(user, workspace)) {
      throw new ForbiddenException(
        'API key creation is restricted to admins by your workspace administrator.',
      );
    }

    return this.apiKeyService.create({ user, workspaceId: workspace.id, dto });
  }

  @HttpCode(HttpStatus.OK)
  @Post('update')
  async update(
    @Body() dto: UpdateApiKeyDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.authorizeKeyAccess(dto.apiKeyId, user, workspace);
    return this.apiKeyService.updateApiKey(dto.apiKeyId, workspace.id, dto.name);
  }

  @HttpCode(HttpStatus.OK)
  @Post('revoke')
  async revoke(
    @Body() dto: RevokeApiKeyDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.authorizeKeyAccess(dto.apiKeyId, user, workspace);
    await this.apiKeyService.revokeApiKey(dto.apiKeyId, workspace.id);
  }

  private canManage(user: User, workspace: Workspace): boolean {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    return ability.can(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.API);
  }

  /**
   * A user may manage a key if they created it (personal) or if they are a
   * workspace admin/owner managing keys across the workspace.
   */
  private async authorizeKeyAccess(
    apiKeyId: string,
    user: User,
    workspace: Workspace,
  ): Promise<void> {
    const apiKey = await this.apiKeyRepo.findById(apiKeyId);

    if (!apiKey || apiKey.deletedAt || apiKey.workspaceId !== workspace.id) {
      throw new NotFoundException('API key not found');
    }

    const isOwner = apiKey.creatorId === user.id;
    if (!isOwner && !this.canManage(user, workspace)) {
      throw new ForbiddenException();
    }
  }
}
