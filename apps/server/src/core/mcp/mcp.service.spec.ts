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

import { ForbiddenException, NotFoundException } from '@nestjs/common';
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

  const pageInX = { id: 'page-x', spaceId: spaceX, workspaceId };
  const pageInY = { id: 'page-y', spaceId: spaceY, workspaceId };
  const pageInOtherWorkspace = {
    id: 'page-z',
    spaceId: 'space-z',
    workspaceId: otherWorkspaceId,
  };

  // Ability that grants read (member of the space).
  const memberAbility = {
    can: jest.fn().mockReturnValue(true),
    cannot: jest.fn().mockReturnValue(false),
  };

  function build(overrides: {
    pages?: Record<string, any>;
    workspaceCanReadMembers?: boolean;
  } = {}) {
    const pages: Record<string, any> = overrides.pages ?? {
      [pageInX.id]: pageInX,
      [pageInY.id]: pageInY,
      [pageInOtherWorkspace.id]: pageInOtherWorkspace,
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
    const pageService = {
      getSidebarPages: jest.fn().mockResolvedValue({ items: [], meta: {} }),
    };
    const pageRepo = {
      findById: jest.fn(async (pageId: string) => pages[pageId] ?? null),
    };
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
    };
  }

  beforeEach(() => {
    memberAbility.can.mockClear();
    memberAbility.cannot.mockClear();
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
