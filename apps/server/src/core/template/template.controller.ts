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
import { Template, User, Workspace } from '@docmost/db/types/entity.types';
import { TemplateRepo } from '@docmost/db/repos/template/template.repo';
import { TemplateService } from './services/template.service';
import SpaceAbilityFactory from '../casl/abilities/space-ability.factory';
import WorkspaceAbilityFactory from '../casl/abilities/workspace-ability.factory';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../casl/interfaces/space-ability.type';
import {
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../casl/interfaces/workspace-ability.type';
import {
  CreateTemplateDto,
  ListTemplatesDto,
  TemplateIdDto,
  UpdateTemplateDto,
  UseTemplateDto,
} from './dto/template.dto';

@UseGuards(JwtAuthGuard)
@Controller('templates')
export class TemplateController {
  constructor(
    private readonly templateService: TemplateService,
    private readonly templateRepo: TemplateRepo,
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('/')
  async list(
    @Body() dto: ListTemplatesDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.templateService.list(user.id, workspace.id, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('info')
  async info(
    @Body() dto: TemplateIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const template = await this.getTemplateOrThrow(dto.templateId, workspace.id, {
      includeContent: true,
    });
    await this.authorizeRead(template, user);
    return template;
  }

  @HttpCode(HttpStatus.OK)
  @Post('create')
  async create(
    @Body() dto: CreateTemplateDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.authorizeWrite(dto.spaceId ?? null, user, workspace);
    return this.templateService.create(user.id, workspace.id, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('update')
  async update(
    @Body() dto: UpdateTemplateDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const template = await this.getTemplateOrThrow(dto.templateId, workspace.id);

    // Must be allowed to write the template in its current scope.
    await this.authorizeWrite(template.spaceId, user, workspace);

    // Re-scoping (e.g. space -> global) also requires write on the target scope.
    if (dto.spaceId !== undefined) {
      const targetSpaceId = dto.spaceId ?? null;
      if (targetSpaceId !== template.spaceId) {
        await this.authorizeWrite(targetSpaceId, user, workspace);
      }
    }

    return this.templateService.update(user.id, workspace.id, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('delete')
  async delete(
    @Body() dto: TemplateIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const template = await this.getTemplateOrThrow(dto.templateId, workspace.id);
    await this.authorizeWrite(template.spaceId, user, workspace);
    await this.templateService.delete(workspace.id, dto.templateId);
  }

  @HttpCode(HttpStatus.OK)
  @Post('use')
  async use(
    @Body() dto: UseTemplateDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const template = await this.getTemplateOrThrow(dto.templateId, workspace.id, {
      includeContent: true,
    });

    // Reading the source template + creating a page in the destination space.
    await this.authorizeRead(template, user);
    await this.authorizeCreatePage(dto.spaceId, user);

    return this.templateService.use(user.id, workspace.id, template, dto);
  }

  // ---------------------------------------------------------------------------
  // Authorization helpers
  // ---------------------------------------------------------------------------

  private async getTemplateOrThrow(
    templateId: string,
    workspaceId: string,
    opts?: { includeContent?: boolean },
  ): Promise<Template> {
    const template = await this.templateRepo.findById(
      templateId,
      workspaceId,
      opts,
    );
    if (!template) {
      throw new NotFoundException('Template not found');
    }
    return template;
  }

  private isWorkspaceAdmin(user: User, workspace: Workspace): boolean {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    return ability.can(
      WorkspaceCaslAction.Manage,
      WorkspaceCaslSubject.Settings,
    );
  }

  private allowsMemberTemplates(workspace: Workspace): boolean {
    return (
      (workspace.settings as any)?.templates?.allowMemberTemplates === true
    );
  }

  /**
   * Read/list/use access:
   *  - space-scoped template -> requires `Read` on that space (membership).
   *  - global template -> any workspace member (JwtAuthGuard already asserts
   *    workspace membership).
   */
  private async authorizeRead(template: Template, user: User): Promise<void> {
    if (!template.spaceId) {
      return;
    }
    await this.authorizeSpace(template.spaceId, user, SpaceCaslAction.Read);
  }

  /**
   * Create/update/delete access:
   *  - space-scoped template -> requires `Edit` on that space, and non-admins
   *    are additionally gated by the `allowMemberTemplates` workspace setting.
   *  - global template (spaceId null) -> workspace admin/owner only.
   */
  private async authorizeWrite(
    spaceId: string | null,
    user: User,
    workspace: Workspace,
  ): Promise<void> {
    if (!spaceId) {
      if (!this.isWorkspaceAdmin(user, workspace)) {
        throw new ForbiddenException(
          'Only workspace admins can manage global templates',
        );
      }
      return;
    }

    await this.authorizeSpace(spaceId, user, SpaceCaslAction.Edit);

    if (!this.isWorkspaceAdmin(user, workspace) && !this.allowsMemberTemplates(workspace)) {
      throw new ForbiddenException(
        'Template management is restricted to admins by your workspace administrator.',
      );
    }
  }

  private async authorizeCreatePage(
    spaceId: string,
    user: User,
  ): Promise<void> {
    await this.authorizeSpace(spaceId, user, SpaceCaslAction.Create);
  }

  /**
   * Runs a space CASL check, mapping "no role in this space" (which the ability
   * factory raises as NotFound) to a 403 so template access never leaks a
   * space's existence.
   */
  private async authorizeSpace(
    spaceId: string,
    user: User,
    action: SpaceCaslAction,
  ): Promise<void> {
    let ability;
    try {
      ability = await this.spaceAbility.createForUser(user, spaceId);
    } catch {
      throw new ForbiddenException();
    }
    if (ability.cannot(action, SpaceCaslSubject.Page)) {
      throw new ForbiddenException();
    }
  }
}
