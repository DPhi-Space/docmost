import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
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
import { SpaceService } from '../space/services/space.service';
import { SpaceMemberService } from '../space/services/space-member.service';
import { PageService } from '../page/services/page.service';
import { CommentService } from '../comment/comment.service';
import { SearchService } from '../search/search.service';
import { SearchDTO } from '../search/dto/search.dto';
import { WorkspaceService } from '../workspace/services/workspace.service';

type Principal = { user: User; workspace: Workspace };
type PageInput = { limit?: number; cursor?: string };

/**
 * Native, read-only, space-scoped MCP (Model Context Protocol) backend.
 *
 * The public tool methods below are the module's authorization boundary: every
 * method that touches a space resolves the target's spaceId and runs the
 * SpaceAbilityFactory read check BEFORE calling the backing service. Calling the
 * backing services directly without this check would bypass space membership and
 * leak private spaces, so the guard lives here (and is unit-tested here) rather
 * than in the thin `buildServer` wiring.
 */
@Injectable()
export class McpService {
  constructor(
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
    private readonly spaceService: SpaceService,
    private readonly spaceMemberService: SpaceMemberService,
    private readonly pageService: PageService,
    private readonly pageRepo: PageRepo,
    private readonly commentService: CommentService,
    private readonly searchService: SearchService,
    private readonly workspaceService: WorkspaceService,
  ) {}

  private toPagination(input?: PageInput): PaginationOptions {
    const pagination = new PaginationOptions();
    if (input?.limit != null) pagination.limit = input.limit;
    if (input?.cursor) pagination.cursor = input.cursor;
    return pagination;
  }

  /**
   * The single authorization boundary: throws ForbiddenException unless the user
   * may read within `spaceId`. SpaceAbilityFactory throws NotFoundException for a
   * non-member (no role in the space), which we normalize to a forbidden error so
   * the tool never distinguishes "private space you can't see" from "missing".
   */
  private async requireSpaceRead(user: User, spaceId: string) {
    let ability: Awaited<ReturnType<SpaceAbilityFactory['createForUser']>>;
    try {
      ability = await this.spaceAbility.createForUser(user, spaceId);
    } catch {
      throw new ForbiddenException('You do not have access to this space');
    }
    if (ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Page)) {
      throw new ForbiddenException('You do not have access to this space');
    }
    return ability;
  }

  /**
   * Resolve a page and confirm it belongs to the principal's workspace before any
   * space check. `PageRepo.findById` does not scope by workspace, so this closes
   * cross-workspace reads (and treats a missing page identically).
   */
  private async requirePageInWorkspace(
    pageId: string,
    workspaceId: string,
    opts?: Parameters<PageRepo['findById']>[1],
  ) {
    const page = await this.pageRepo.findById(pageId, opts);
    if (!page || page.workspaceId !== workspaceId) {
      throw new NotFoundException('Page not found');
    }
    return page;
  }

  // ---- read-only tool implementations -------------------------------------

  getCurrentUser(user: User) {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      avatarUrl: user.avatarUrl,
      role: user.role,
      locale: user.locale,
      timezone: user.timezone,
      workspaceId: user.workspaceId,
    };
  }

  /** Self-scoping: getUserSpaces only ever returns the user's own spaces. */
  listSpaces(user: User, input?: PageInput) {
    return this.spaceMemberService.getUserSpaces(user.id, this.toPagination(input));
  }

  async getSpace(user: User, workspace: Workspace, spaceId: string) {
    await this.requireSpaceRead(user, spaceId);
    return this.spaceService.getSpaceInfo(spaceId, workspace.id);
  }

  async searchPages(
    user: User,
    workspace: Workspace,
    input: { query: string; spaceId?: string; limit?: number },
  ) {
    // When a space is named explicitly, gate it — SearchService trusts the
    // supplied spaceId without checking membership. With no spaceId, passing
    // userId makes SearchService auto-restrict to the user's spaces.
    if (input.spaceId) {
      await this.requireSpaceRead(user, input.spaceId);
    }
    const searchParams: SearchDTO = Object.assign(new SearchDTO(), {
      query: input.query,
      ...(input.spaceId ? { spaceId: input.spaceId } : {}),
      ...(input.limit != null ? { limit: input.limit } : {}),
    });
    return this.searchService.searchPage(searchParams, {
      userId: user.id,
      workspaceId: workspace.id,
    });
  }

  async getPage(user: User, workspace: Workspace, pageId: string) {
    const page = await this.requirePageInWorkspace(pageId, workspace.id, {
      includeContent: true,
      includeCreator: true,
      includeSpace: true,
    });
    await this.requireSpaceRead(user, page.spaceId);
    return page;
  }

  async listPages(
    user: User,
    workspace: Workspace,
    spaceId: string,
    input?: PageInput,
  ) {
    const ability = await this.requireSpaceRead(user, spaceId);
    const spaceCanEdit = ability.can(SpaceCaslAction.Edit, SpaceCaslSubject.Page);
    return this.pageService.getSidebarPages(
      spaceId,
      this.toPagination(input),
      undefined,
      user.id,
      spaceCanEdit,
    );
  }

  async listChildPages(
    user: User,
    workspace: Workspace,
    pageId: string,
    input?: PageInput,
  ) {
    const page = await this.requirePageInWorkspace(pageId, workspace.id);
    const ability = await this.requireSpaceRead(user, page.spaceId);
    const spaceCanEdit = ability.can(SpaceCaslAction.Edit, SpaceCaslSubject.Page);
    return this.pageService.getSidebarPages(
      page.spaceId,
      this.toPagination(input),
      page.id,
      user.id,
      spaceCanEdit,
    );
  }

  async getComments(
    user: User,
    workspace: Workspace,
    pageId: string,
    input?: PageInput,
  ) {
    const page = await this.requirePageInWorkspace(pageId, workspace.id);
    await this.requireSpaceRead(user, page.spaceId);
    return this.commentService.findByPageId(page.id, this.toPagination(input));
  }

  listWorkspaceMembers(user: User, workspace: Workspace, input?: PageInput) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (ability.cannot(WorkspaceCaslAction.Read, WorkspaceCaslSubject.Member)) {
      throw new ForbiddenException('You do not have access to workspace members');
    }
    return this.workspaceService.getWorkspaceUsers(
      workspace.id,
      this.toPagination(input),
    );
  }

  // ---- MCP server wiring --------------------------------------------------

  /**
   * Build a fresh MCP server whose tools are bound to a single principal. The
   * controller instantiates one per request (stateless transport) so the
   * `{ user, workspace }` closure never leaks across requests.
   */
  buildServer(principal: Principal): McpServer {
    const { user, workspace } = principal;
    const server = new McpServer({
      name: 'docmost',
      version: '1.0.0',
    });

    const limit = z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Maximum number of items to return (1-100, default 20).');
    const cursor = z
      .string()
      .optional()
      .describe('Pagination cursor from a previous response (meta.nextCursor).');

    const run = async (
      fn: () => Promise<unknown> | unknown,
    ): Promise<CallToolResult> => {
      try {
        const data = await fn();
        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return {
          content: [{ type: 'text', text: message }],
          isError: true,
        };
      }
    };

    server.registerTool(
      'get_current_user',
      {
        title: 'Get current user',
        description: 'Return the authenticated user for this API key.',
      },
      () => run(() => this.getCurrentUser(user)),
    );

    server.registerTool(
      'list_spaces',
      {
        title: 'List spaces',
        description:
          'List the spaces the authenticated user is a member of, with pagination.',
        inputSchema: { limit, cursor },
      },
      (args) => run(() => this.listSpaces(user, args)),
    );

    server.registerTool(
      'get_space',
      {
        title: 'Get space',
        description:
          'Get information about a single space the user can access, by id.',
        inputSchema: { spaceId: z.string().describe('The space id.') },
      },
      (args) => run(() => this.getSpace(user, workspace, args.spaceId)),
    );

    server.registerTool(
      'search_pages',
      {
        title: 'Search pages',
        description:
          'Full-text search pages. Results are limited to spaces the user can access. Optionally restrict to a single space.',
        inputSchema: {
          query: z.string().describe('The search text.'),
          spaceId: z
            .string()
            .optional()
            .describe('Restrict the search to this space id.'),
          limit,
        },
      },
      (args) => run(() => this.searchPages(user, workspace, args)),
    );

    server.registerTool(
      'get_page',
      {
        title: 'Get page',
        description:
          'Get a page (including its content) by page id or slug id, if the user can read its space.',
        inputSchema: {
          pageId: z.string().describe('The page id or slug id.'),
        },
      },
      (args) => run(() => this.getPage(user, workspace, args.pageId)),
    );

    server.registerTool(
      'list_pages',
      {
        title: 'List pages',
        description:
          'List the top-level pages of a space the user can access, with pagination.',
        inputSchema: {
          spaceId: z.string().describe('The space id.'),
          limit,
          cursor,
        },
      },
      (args) => run(() => this.listPages(user, workspace, args.spaceId, args)),
    );

    server.registerTool(
      'list_child_pages',
      {
        title: 'List child pages',
        description:
          'List the direct child pages of a page the user can access, with pagination.',
        inputSchema: {
          pageId: z.string().describe('The parent page id or slug id.'),
          limit,
          cursor,
        },
      },
      (args) =>
        run(() => this.listChildPages(user, workspace, args.pageId, args)),
    );

    server.registerTool(
      'get_comments',
      {
        title: 'Get comments',
        description:
          'List the comments on a page the user can access, with pagination.',
        inputSchema: {
          pageId: z.string().describe('The page id or slug id.'),
          limit,
          cursor,
        },
      },
      (args) => run(() => this.getComments(user, workspace, args.pageId, args)),
    );

    server.registerTool(
      'list_workspace_members',
      {
        title: 'List workspace members',
        description:
          'List the members of the workspace (requires workspace member-read access).',
        inputSchema: { limit, cursor },
      },
      (args) => run(() => this.listWorkspaceMembers(user, workspace, args)),
    );

    return server;
  }
}
