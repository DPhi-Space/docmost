// PageService and CommentService transitively import the collaboration gateway
// (-> lib0, ESM), which Jest's transformIgnorePatterns doesn't transform and
// which is irrelevant to this authorization test. Stub them as bare DI tokens so
// importing McpService doesn't drag in that module graph. (Same limitation
// breaks the upstream page.service.spec.ts / comment.service.spec.ts.)
jest.mock('../page/services/page.service', () => ({
  PageService: class PageService {},
}));
jest.mock('../comment/comment.service', () => ({
  CommentService: class CommentService {},
}));

import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { McpService } from './mcp.service';
import { SpaceCaslAction, SpaceCaslSubject } from '../casl/interfaces/space-ability.type';
import {
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../casl/interfaces/workspace-ability.type';

/**
 * Authorization boundary test (issue #10 acceptance criteria):
 * user A is a member of space X but NOT space Y (and not workspace-2). The MCP
 * tools must never leak space Y (or another workspace) through any read tool.
 */
describe('McpService authorization boundary', () => {
  const workspaceId = 'ws-1';
  const otherWorkspaceId = 'ws-2';
  const spaceX = 'space-x';
  const spaceY = 'space-y';

  const userA = { id: 'user-a', workspaceId } as any;
  const workspace = { id: workspaceId, settings: { ai: { mcp: true } } } as any;
  // Same workspace with the fork's separate write opt-in flipped on (#15).
  const writeWorkspace = {
    id: workspaceId,
    settings: { ai: { mcp: true, mcpWrite: true } },
  } as any;

  const pageInX = { id: 'page-x', slugId: 'slug-x', spaceId: spaceX, workspaceId };
  const pageInY = { id: 'page-y', slugId: 'slug-y', spaceId: spaceY, workspaceId };
  const pageInOtherWorkspace = {
    id: 'page-z',
    slugId: 'slug-z',
    spaceId: 'space-z',
    workspaceId: otherWorkspaceId,
  };
  // Readable, but not editable: a page the user may view but not write.
  const readOnlyPageInX = {
    id: 'page-ro',
    slugId: 'slug-ro',
    spaceId: spaceX,
    workspaceId,
  };
  // The fork's page lock. Readable like any page; refused for every write.
  const lockedPageInX = {
    id: 'page-locked',
    slugId: 'slug-locked',
    spaceId: spaceX,
    workspaceId,
    isLocked: true,
  };

  // Ability that grants read (member of the space).
  const memberAbility = {
    can: jest.fn().mockReturnValue(true),
    cannot: jest.fn().mockReturnValue(false),
  };

  function build(overrides: {
    pages?: Record<string, any>;
    workspaceCanReadMembers?: boolean;
    spaceCanCreatePages?: boolean;
    collabRedisDisabled?: boolean;
    descendants?: Record<string, any[]>;
  } = {}) {
    const pages: Record<string, any> = overrides.pages ?? {
      [pageInX.id]: pageInX,
      [pageInY.id]: pageInY,
      [pageInOtherWorkspace.id]: pageInOtherWorkspace,
      [readOnlyPageInX.id]: readOnlyPageInX,
      [lockedPageInX.id]: lockedPageInX,
    };

    // Real SpaceAbilityFactory throws NotFoundException for a non-member; only
    // space X resolves to a granting ability for user A.
    const spaceAbility = {
      createForUser: jest.fn(async (_user: any, spaceId: string) => {
        if (spaceId === spaceX) return memberAbility;
        throw new NotFoundException('Space permissions not found');
      }),
    };

    const workspaceAbility = {
      createForUser: jest.fn(() => ({
        can: () => overrides.workspaceCanReadMembers !== false,
        cannot: (action: string, subject: string) => {
          if (
            action === WorkspaceCaslAction.Read &&
            subject === WorkspaceCaslSubject.Member
          ) {
            return overrides.workspaceCanReadMembers === false;
          }
          return false;
        },
      })),
    };

    const spaceService = { getSpaceInfo: jest.fn().mockResolvedValue({ id: spaceX }) };
    const spaceMemberService = {
      getUserSpaces: jest
        .fn()
        .mockResolvedValue({ items: [{ id: spaceX }], meta: {} }),
    };
    if (overrides.spaceCanCreatePages === false) {
      memberAbility.cannot.mockImplementation(
        (action: string, subject: string) =>
          action === SpaceCaslAction.Create && subject === SpaceCaslSubject.Page,
      );
    }

    const pageService = {
      getSidebarPages: jest.fn().mockResolvedValue({ items: [], meta: {} }),
      create: jest
        .fn()
        .mockResolvedValue({ ...pageInX, id: 'new-page', title: 'New' }),
      update: jest.fn(async (page: any) => ({ ...page, title: 'Updated' })),
      removePage: jest.fn().mockResolvedValue(undefined),
    };
    const pageRepo = {
      findById: jest.fn(async (pageId: string) => pages[pageId] ?? null),
      // Real traversal returns the root page plus its descendants.
      getPageAndDescendants: jest.fn(async (pageId: string) => [
        pages[pageId],
        ...(overrides.descendants?.[pageId] ?? []),
      ]),
    };

    // Mirrors the real PageAccessService: a non-member space blows up the way
    // SpaceAbilityFactory does, and the lock / page-level restriction both
    // surface as a plain edit denial (the lock is folded into canUserEditPage).
    const nonEditable = new Set([readOnlyPageInX.id, lockedPageInX.id]);
    const pageAccessService = {
      validateCanEdit: jest.fn(async (page: any) => {
        if (page.spaceId !== spaceX) {
          throw new NotFoundException('Space permissions not found');
        }
        if (nonEditable.has(page.id)) {
          throw new ForbiddenException();
        }
        return { hasRestriction: false };
      }),
    };

    const environmentService = {
      isCollabDisableRedis: jest.fn(
        () => overrides.collabRedisDisabled === true,
      ),
    };
    const auditService = { log: jest.fn() };
    const commentService = {
      findByPageId: jest.fn().mockResolvedValue({ items: [], meta: {} }),
    };
    const searchService = {
      searchPage: jest.fn().mockResolvedValue({ items: [] }),
    };
    const workspaceService = {
      getWorkspaceUsers: jest.fn().mockResolvedValue({ items: [], meta: {} }),
    };

    const service = new McpService(
      spaceAbility as any,
      workspaceAbility as any,
      spaceService as any,
      spaceMemberService as any,
      pageService as any,
      pageRepo as any,
      commentService as any,
      searchService as any,
      workspaceService as any,
      pageAccessService as any,
      environmentService as any,
      auditService as any,
    );

    return {
      service,
      spaceAbility,
      spaceService,
      spaceMemberService,
      pageService,
      pageRepo,
      commentService,
      searchService,
      workspaceService,
      pageAccessService,
      environmentService,
      auditService,
    };
  }

  beforeEach(() => {
    memberAbility.can.mockReset().mockReturnValue(true);
    memberAbility.cannot.mockReset().mockReturnValue(false);
  });

  describe('get_page', () => {
    it('returns a page in a space the user can read', async () => {
      const { service } = build();
      await expect(service.getPage(userA, workspace, pageInX.id)).resolves.toBe(
        pageInX,
      );
    });

    it('rejects a page in a space the user is NOT a member of', async () => {
      const { service } = build();
      await expect(
        service.getPage(userA, workspace, pageInY.id),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects a page belonging to a different workspace (never runs the space check)', async () => {
      const { service, spaceAbility } = build();
      await expect(
        service.getPage(userA, workspace, pageInOtherWorkspace.id),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(spaceAbility.createForUser).not.toHaveBeenCalled();
    });

    it('rejects a missing page', async () => {
      const { service } = build();
      await expect(
        service.getPage(userA, workspace, 'does-not-exist'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('get_space', () => {
    it('returns an accessible space', async () => {
      const { service, spaceService } = build();
      await service.getSpace(userA, workspace, spaceX);
      expect(spaceService.getSpaceInfo).toHaveBeenCalledWith(spaceX, workspaceId);
    });

    it('rejects a space the user is not a member of and never reads it', async () => {
      const { service, spaceService } = build();
      await expect(
        service.getSpace(userA, workspace, spaceY),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(spaceService.getSpaceInfo).not.toHaveBeenCalled();
    });
  });

  describe('list_spaces', () => {
    it('is self-scoped to the user (only returns their spaces)', async () => {
      const { service, spaceMemberService } = build();
      const result: any = await service.listSpaces(userA);
      expect(spaceMemberService.getUserSpaces).toHaveBeenCalledWith(
        userA.id,
        expect.objectContaining({ limit: 20 }),
      );
      expect(result.items).toEqual([{ id: spaceX }]);
      expect(result.items).not.toContainEqual({ id: spaceY });
    });
  });

  describe('search_pages', () => {
    it('passes the user id so the service self-restricts to accessible spaces', async () => {
      const { service, searchService } = build();
      await service.searchPages(userA, workspace, { query: 'hello' });
      expect(searchService.searchPage).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'hello' }),
        { userId: userA.id, workspaceId },
      );
    });

    it('rejects a search explicitly scoped to a space the user cannot read', async () => {
      const { service, searchService } = build();
      await expect(
        service.searchPages(userA, workspace, { query: 'x', spaceId: spaceY }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(searchService.searchPage).not.toHaveBeenCalled();
    });
  });

  describe('list_pages / list_child_pages', () => {
    it('rejects listing pages of an inaccessible space', async () => {
      const { service, pageService } = build();
      await expect(
        service.listPages(userA, workspace, spaceY),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(pageService.getSidebarPages).not.toHaveBeenCalled();
    });

    it('rejects listing children of a page in an inaccessible space', async () => {
      const { service, pageService } = build();
      await expect(
        service.listChildPages(userA, workspace, pageInY.id),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(pageService.getSidebarPages).not.toHaveBeenCalled();
    });

    it('lists pages of an accessible space with the derived edit flag', async () => {
      const { service, pageService } = build();
      await service.listPages(userA, workspace, spaceX, { limit: 10 });
      expect(pageService.getSidebarPages).toHaveBeenCalledWith(
        spaceX,
        expect.objectContaining({ limit: 10 }),
        undefined,
        userA.id,
        true,
      );
    });
  });

  describe('get_comments', () => {
    it('rejects comments on a page in an inaccessible space', async () => {
      const { service, commentService } = build();
      await expect(
        service.getComments(userA, workspace, pageInY.id),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(commentService.findByPageId).not.toHaveBeenCalled();
    });

    it('returns comments on an accessible page', async () => {
      const { service, commentService } = build();
      await service.getComments(userA, workspace, pageInX.id);
      expect(commentService.findByPageId).toHaveBeenCalledWith(
        pageInX.id,
        expect.anything(),
      );
    });
  });

  describe('list_workspace_members', () => {
    it('returns members when the user has member-read access', async () => {
      const { service, workspaceService } = build({
        workspaceCanReadMembers: true,
      });
      await service.listWorkspaceMembers(userA, workspace);
      expect(workspaceService.getWorkspaceUsers).toHaveBeenCalledWith(
        workspaceId,
        expect.anything(),
      );
    });

    it('rejects when the user lacks member-read access', async () => {
      const { service, workspaceService } = build({
        workspaceCanReadMembers: false,
      });
      expect(() =>
        service.listWorkspaceMembers(userA, workspace),
      ).toThrow(ForbiddenException);
      expect(workspaceService.getWorkspaceUsers).not.toHaveBeenCalled();
    });
  });

  // -- write tools (issue #15) ------------------------------------------------

  describe('write enablement switch', () => {
    it('refuses create_page when the workspace write switch is off', async () => {
      const { service, pageService } = build();
      await expect(
        service.createPage(userA, workspace, { spaceId: spaceX, title: 'Hi' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(pageService.create).not.toHaveBeenCalled();
    });

    it('refuses update_page when the workspace write switch is off', async () => {
      const { service, pageService } = build();
      await expect(
        service.updatePage(userA, workspace, {
          pageId: pageInX.id,
          content: 'hello',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(pageService.update).not.toHaveBeenCalled();
    });

    it('refuses delete_page when the workspace write switch is off', async () => {
      const { service, pageService } = build();
      await expect(
        service.deletePage(userA, workspace, { pageId: pageInX.id }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(pageService.removePage).not.toHaveBeenCalled();
    });
  });

  describe('create_page', () => {
    it('creates at the root of a space the user may create in', async () => {
      const { service, pageService } = build();
      const result: any = await service.createPage(userA, writeWorkspace, {
        spaceId: spaceX,
        title: 'Notes',
        content: '# hi',
        format: 'markdown',
      });
      expect(pageService.create).toHaveBeenCalledWith(
        userA.id,
        workspaceId,
        expect.objectContaining({
          spaceId: spaceX,
          title: 'Notes',
          content: '# hi',
          format: 'markdown',
        }),
      );
      expect(result.id).toBe('new-page');
    });

    it('checks the space-level create ability at the root of a space', async () => {
      const { service, pageService } = build({ spaceCanCreatePages: false });
      await expect(
        service.createPage(userA, writeWorkspace, { spaceId: spaceX }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(pageService.create).not.toHaveBeenCalled();
    });

    it('refuses a space the user is not a member of, and never creates', async () => {
      const { service, pageService } = build();
      await expect(
        service.createPage(userA, writeWorkspace, { spaceId: spaceY }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(pageService.create).not.toHaveBeenCalled();
    });

    it('checks edit permission on the parent when nesting under a page', async () => {
      const { service, pageAccessService, pageService } = build();
      await service.createPage(userA, writeWorkspace, {
        spaceId: spaceX,
        parentPageId: pageInX.id,
      });
      expect(pageAccessService.validateCanEdit).toHaveBeenCalledWith(
        pageInX,
        userA,
      );
      expect(pageService.create).toHaveBeenCalled();
    });

    it('refuses to nest under a page the user cannot edit', async () => {
      const { service, pageService } = build();
      await expect(
        service.createPage(userA, writeWorkspace, {
          spaceId: spaceX,
          parentPageId: readOnlyPageInX.id,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(pageService.create).not.toHaveBeenCalled();
    });

    it('refuses to nest under a locked page', async () => {
      const { service, pageService } = build();
      await expect(
        service.createPage(userA, writeWorkspace, {
          spaceId: spaceX,
          parentPageId: lockedPageInX.id,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(pageService.create).not.toHaveBeenCalled();
    });

    it('reports a parent page in another workspace as not found', async () => {
      const { service, pageService } = build();
      await expect(
        service.createPage(userA, writeWorkspace, {
          spaceId: spaceX,
          parentPageId: pageInOtherWorkspace.id,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(pageService.create).not.toHaveBeenCalled();
    });

    it('rejects unparseable editor JSON before touching the page service', async () => {
      const { service, pageService } = build();
      await expect(
        service.createPage(userA, writeWorkspace, {
          spaceId: spaceX,
          content: 'not json',
          format: 'json',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(pageService.create).not.toHaveBeenCalled();
    });
  });

  describe('update_page', () => {
    it('defaults the content operation to append', async () => {
      const { service, pageService } = build();
      await service.updatePage(userA, writeWorkspace, {
        pageId: pageInX.id,
        content: 'a line',
      });
      expect(pageService.update).toHaveBeenCalledWith(
        pageInX,
        expect.objectContaining({ operation: 'append', format: 'markdown' }),
        userA,
      );
    });

    it('passes an explicit replace operation through', async () => {
      const { service, pageService } = build();
      await service.updatePage(userA, writeWorkspace, {
        pageId: pageInX.id,
        content: 'all new',
        operation: 'replace',
      });
      expect(pageService.update).toHaveBeenCalledWith(
        pageInX,
        expect.objectContaining({ operation: 'replace' }),
        userA,
      );
    });

    it('renames without content and sends no content operation', async () => {
      const { service, pageService } = build();
      await service.updatePage(userA, writeWorkspace, {
        pageId: pageInX.id,
        title: 'Renamed',
      });
      const dto: any = (pageService.update.mock.calls as any[])[0][1];
      expect(dto.title).toBe('Renamed');
      expect(dto.content).toBeUndefined();
      expect(dto.operation).toBeUndefined();
    });

    it('refuses a page the user can read but not edit', async () => {
      const { service, pageService } = build();
      await expect(
        service.updatePage(userA, writeWorkspace, {
          pageId: readOnlyPageInX.id,
          content: 'x',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(pageService.update).not.toHaveBeenCalled();
    });

    it('refuses a locked page, which stays readable', async () => {
      const { service, pageService } = build();
      await expect(
        service.updatePage(userA, writeWorkspace, {
          pageId: lockedPageInX.id,
          content: 'x',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(pageService.update).not.toHaveBeenCalled();

      // The same locked page is still readable over MCP.
      await expect(
        service.getPage(userA, writeWorkspace, lockedPageInX.id),
      ).resolves.toBe(lockedPageInX);
    });

    it('refuses a page in a space the user is not a member of', async () => {
      const { service, pageService } = build();
      await expect(
        service.updatePage(userA, writeWorkspace, {
          pageId: pageInY.id,
          content: 'x',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(pageService.update).not.toHaveBeenCalled();
    });

    it('reports a page in another workspace as not found', async () => {
      const { service, pageAccessService } = build();
      await expect(
        service.updatePage(userA, writeWorkspace, {
          pageId: pageInOtherWorkspace.id,
          content: 'x',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(pageAccessService.validateCanEdit).not.toHaveBeenCalled();
    });

    it('refuses a content write when the collaboration Redis backend is disabled', async () => {
      const { service, pageService } = build({ collabRedisDisabled: true });
      await expect(
        service.updatePage(userA, writeWorkspace, {
          pageId: pageInX.id,
          content: 'x',
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(pageService.update).not.toHaveBeenCalled();
    });

    it('still allows a title-only update without the collaboration backend', async () => {
      const { service, pageService } = build({ collabRedisDisabled: true });
      await service.updatePage(userA, writeWorkspace, {
        pageId: pageInX.id,
        title: 'Renamed',
      });
      expect(pageService.update).toHaveBeenCalled();
    });
  });

  describe('delete_page', () => {
    it('trashes a childless page the user can edit', async () => {
      const { service, pageService } = build();
      const result: any = await service.deletePage(userA, writeWorkspace, {
        pageId: pageInX.id,
      });
      expect(pageService.removePage).toHaveBeenCalledWith(
        pageInX.id,
        userA.id,
        workspaceId,
      );
      expect(result).toMatchObject({ trashed: true, descendantsTrashed: 0 });
    });

    it('refuses a page with descendants and names the count', async () => {
      const { service, pageService } = build({
        descendants: { [pageInX.id]: [{ id: 'c1' }, { id: 'c2' }] },
      });
      await expect(
        service.deletePage(userA, writeWorkspace, { pageId: pageInX.id }),
      ).rejects.toThrow(/2 descendant/);
      await expect(
        service.deletePage(userA, writeWorkspace, { pageId: pageInX.id }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(pageService.removePage).not.toHaveBeenCalled();
    });

    it('trashes the subtree once the caller confirms', async () => {
      const { service, pageService } = build({
        descendants: { [pageInX.id]: [{ id: 'c1' }, { id: 'c2' }] },
      });
      const result: any = await service.deletePage(userA, writeWorkspace, {
        pageId: pageInX.id,
        confirmDeleteChildren: true,
      });
      expect(pageService.removePage).toHaveBeenCalled();
      expect(result.descendantsTrashed).toBe(2);
    });

    it('refuses a locked page', async () => {
      const { service, pageService } = build();
      await expect(
        service.deletePage(userA, writeWorkspace, {
          pageId: lockedPageInX.id,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(pageService.removePage).not.toHaveBeenCalled();
    });

    it('refuses a page in a space the user is not a member of', async () => {
      const { service, pageService } = build();
      await expect(
        service.deletePage(userA, writeWorkspace, { pageId: pageInY.id }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(pageService.removePage).not.toHaveBeenCalled();
    });

    it('reports a page in another workspace as not found', async () => {
      const { service, pageService } = build();
      await expect(
        service.deletePage(userA, writeWorkspace, {
          pageId: pageInOtherWorkspace.id,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(pageService.removePage).not.toHaveBeenCalled();
    });
  });

  it('requireSpaceRead uses the Read/Page ability check', async () => {
    const { service } = build();
    // Accessible path exercises ability.cannot(Read, Page).
    await service.getSpace(userA, workspace, spaceX);
    expect(memberAbility.cannot).toHaveBeenCalledWith(
      SpaceCaslAction.Read,
      SpaceCaslSubject.Page,
    );
  });
});
