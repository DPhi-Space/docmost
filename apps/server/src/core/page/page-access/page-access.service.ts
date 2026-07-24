import { ForbiddenException, Injectable } from '@nestjs/common';
import { Page, User } from '@docmost/db/types/entity.types';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import SpaceAbilityFactory from '../../casl/abilities/space-ability.factory';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../../casl/interfaces/space-ability.type';
import { SpaceRepo } from '@docmost/db/repos/space/space.repo';
import { CacheOptions } from '../../../common/helpers/with-cache';

@Injectable()
export class PageAccessService {
  constructor(
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly spaceRepo: SpaceRepo,
  ) {}

  /**
   * Validate user can view page, throws ForbiddenException if not.
   * If page has restrictions: page-level permission determines access.
   * If no restrictions: space-level permission determines access.
   */
  async validateCanView(
    page: Page,
    user: User,
    opts?: CacheOptions,
  ): Promise<void> {
    // TODO: cache by pageId and userId.
    const ability = await this.spaceAbility.createForUser(
      user,
      page.spaceId,
      opts,
    );

    // User must be at least a space member
    if (ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Page)) {
      throw new ForbiddenException();
    }

    const canAccess = await this.pagePermissionRepo.canUserAccessPage(
      user.id,
      page.id,
      opts,
    );
    if (!canAccess) {
      throw new ForbiddenException();
    }
  }

  /**
   * Validate user can view page AND return effective canEdit permission.
   * Combines access check + edit permission in a single query pass.
   */
  async validateCanViewWithPermissions(
    page: Page,
    user: User,
  ): Promise<{
    canEdit: boolean;
    hasRestriction: boolean;
    canManageShare: boolean;
  }> {
    const ability = await this.spaceAbility.createForUser(user, page.spaceId);

    if (ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Page)) {
      throw new ForbiddenException();
    }

    const {
      hasRealRestriction,
      hasAnyRestriction,
      canAccess,
      canEdit,
      canEditIgnoringLock,
    } = await this.pagePermissionRepo.canUserEditPage(user.id, page.id);

    if (hasAnyRestriction && !canAccess) {
      throw new ForbiddenException();
    }

    return {
      canEdit: hasAnyRestriction
        ? canEdit
        : ability.can(SpaceCaslAction.Edit, SpaceCaslSubject.Page),
      // Reported to the client as `permissions.hasRestriction`, where it gates
      // public sharing. A page lock removes edit rights but must not make the
      // page unshareable, so this reports only genuine page_access restrictions
      // — enforcement above still routes on hasAnyRestriction.
      hasRestriction: hasRealRestriction,
      // Lets the client enable the publish controls on a locked page. Mirrors
      // validateCanManageShare, which is what actually enforces it.
      canManageShare: hasRealRestriction
        ? canEditIgnoringLock
        : ability.can(SpaceCaslAction.Edit, SpaceCaslSubject.Page),
    };
  }

  /**
   * Validate user can edit page, throws ForbiddenException if not.
   * If page has restrictions: page-level writer permission determines access.
   * If no restrictions: space-level edit permission determines access.
   */
  async validateCanEdit(
    page: Page,
    user: User,
  ): Promise<{ hasRestriction: boolean }> {
    const ability = await this.spaceAbility.createForUser(user, page.spaceId);

    // User must be at least a space member
    if (ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Page)) {
      throw new ForbiddenException();
    }

    const { hasRealRestriction, hasAnyRestriction, canEdit } =
      await this.pagePermissionRepo.canUserEditPage(user.id, page.id);

    if (hasAnyRestriction) {
      // Page has restrictions - use page-level permission
      if (!canEdit) {
        throw new ForbiddenException();
      }
    } else {
      // No restrictions - use space-level permission
      if (ability.cannot(SpaceCaslAction.Edit, SpaceCaslSubject.Page)) {
        throw new ForbiddenException();
      }
    }

    // Client-facing flag: genuine restrictions only, never a lock (see
    // validateCanViewWithPermissions).
    return { hasRestriction: hasRealRestriction };
  }

  /**
   * Validate user may create, change or remove this page's public share.
   *
   * Fork feature: publishing is authority over the page, not a content edit,
   * so — unlike validateCanEdit — a page lock does not deny it. A frozen page
   * must stay publishable (and un-publishable) by whoever could publish it
   * before the freeze. Genuine page_access restrictions still apply, as does
   * the space-level edit permission when there are none.
   */
  async validateCanManageShare(page: Page, user: User): Promise<void> {
    const ability = await this.spaceAbility.createForUser(user, page.spaceId);

    if (ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Page)) {
      throw new ForbiddenException();
    }

    const { hasRealRestriction, canEditIgnoringLock } =
      await this.pagePermissionRepo.canUserEditPage(user.id, page.id);

    if (hasRealRestriction) {
      if (!canEditIgnoringLock) {
        throw new ForbiddenException();
      }
    } else if (ability.cannot(SpaceCaslAction.Edit, SpaceCaslSubject.Page)) {
      throw new ForbiddenException();
    }
  }

  /**
   * Validate user can create a root page in the space, throws if not.
   * For non-HTTP callers (Slack, integrations) that skip the controller check.
   */
  async validateCanCreate(spaceId: string, user: User): Promise<void> {
    const ability = await this.spaceAbility.createForUser(user, spaceId);
    if (ability.cannot(SpaceCaslAction.Create, SpaceCaslSubject.Page)) {
      throw new ForbiddenException();
    }
  }

  async validateCanComment(
    page: Page,
    user: User,
    workspaceId: string,
  ): Promise<void> {
    try {
      await this.validateCanEdit(page, user);
      return;
    } catch {
      // User cannot edit — check if reader commenting is enabled
    }

    await this.validateCanView(page, user);

    const space = await this.spaceRepo.findById(page.spaceId, workspaceId);
    const settings = space?.settings as Record<string, any> | null;
    if (!settings?.comments?.allowViewerComments) {
      throw new ForbiddenException();
    }
  }
}
