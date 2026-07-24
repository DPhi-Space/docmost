import { Injectable } from '@nestjs/common';
import { TemplateRepo } from '@docmost/db/repos/template/template.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PageService } from '../../page/services/page.service';
import {
  Page,
  Template,
  UpdatableTemplate,
} from '@docmost/db/types/entity.types';
import { jsonToText } from 'src/collaboration/collaboration.util';
import {
  CreateTemplateDto,
  ListTemplatesDto,
  UpdateTemplateDto,
  UseTemplateDto,
} from '../dto/template.dto';

@Injectable()
export class TemplateService {
  constructor(
    private readonly templateRepo: TemplateRepo,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly pageService: PageService,
  ) {}

  async list(userId: string, workspaceId: string, dto: ListTemplatesDto) {
    // Spaces the user belongs to (directly or via a group). The repo ORs these
    // with global (spaceId = null) templates and applies the optional filter.
    const accessibleSpaceIds =
      await this.spaceMemberRepo.getUserSpaceIds(userId);

    return this.templateRepo.findTemplates(
      workspaceId,
      accessibleSpaceIds,
      dto,
      { spaceId: dto.spaceId },
    );
  }

  async create(
    userId: string,
    workspaceId: string,
    dto: CreateTemplateDto,
  ): Promise<Template> {
    const { id } = await this.templateRepo.insertTemplate({
      title: dto.title,
      spaceId: dto.spaceId ?? null,
      workspaceId,
      creatorId: userId,
      lastUpdatedById: userId,
    });

    return this.templateRepo.findById(id, workspaceId, {
      includeContent: true,
    });
  }

  async update(
    userId: string,
    workspaceId: string,
    dto: UpdateTemplateDto,
  ): Promise<Template> {
    const updatable: UpdatableTemplate = {
      lastUpdatedById: userId,
    };

    if (dto.title !== undefined) {
      updatable.title = dto.title;
    }
    if (dto.icon !== undefined) {
      updatable.icon = dto.icon;
    }
    if (dto.spaceId !== undefined) {
      // null => move to workspace-global scope.
      updatable.spaceId = dto.spaceId ?? null;
    }
    if (dto.content !== undefined) {
      updatable.content = dto.content;
      // Feed the tsv trigger so full-text search stays in sync with content.
      updatable.textContent = jsonToText(dto.content);
    }

    await this.templateRepo.updateTemplate(updatable, dto.templateId, workspaceId);

    return this.templateRepo.findById(dto.templateId, workspaceId, {
      includeContent: true,
    });
  }

  async delete(workspaceId: string, templateId: string): Promise<void> {
    await this.templateRepo.deleteTemplate(templateId, workspaceId);
  }

  /**
   * Instantiate a real page from a template's stored content. Reuses
   * PageService.create() so the new page gets a freshly generated ydoc,
   * textContent, slug, position and page watchers — exactly like a normal
   * page create (never touches the collaboration/persistence path).
   *
   * Attachment note: the template editor cannot upload attachments (every
   * editor upload path bails without an `editor.storage.pageId`, which the
   * template editor never sets), so templates hold no managed attachment rows
   * to remap here. The one way an attachment *node* can reach a template is by
   * pasting it from an existing page; such a page created from the template
   * would share that pre-existing attachment reference. This is an accepted v1
   * limitation (see PR notes) rather than a silent shared-attachment page.
   */
  async use(
    userId: string,
    workspaceId: string,
    template: Template,
    dto: UseTemplateDto,
  ): Promise<Page> {
    return this.pageService.create(userId, workspaceId, {
      title: template.title ?? undefined,
      icon: template.icon ?? undefined,
      spaceId: dto.spaceId,
      parentPageId: dto.parentPageId,
      content: (template.content as object) ?? undefined,
      format: 'json',
    });
  }
}
