import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Page, User, Workspace } from '@docmost/db/types/entity.types';
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
import { PageAccessService } from '../page/page-access/page-access.service';
import { ContentFormat } from '../page/dto/create-page.dto';
import { ContentOperation } from '../page/dto/update-page.dto';
import { CommentService } from '../comment/comment.service';
import { SearchService } from '../search/search.service';
import { SearchDTO } from '../search/dto/search.dto';
import { WorkspaceService } from '../workspace/services/workspace.service';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import { getPageTitle } from '../../common/helpers';

type Principal = { user: User; workspace: Workspace };
type PageInput = { limit?: number; cursor?: string };

type CreatePageInput = {
  spaceId: string;
  parentPageId?: string;
  title?: string;
  icon?: string;
  content?: string;
  format?: ContentFormat;
};

type UpdatePageInput = {
  pageId: string;
  title?: string;
  icon?: string;
  content?: string;
  format?: ContentFormat;
  operation?: ContentOperation;
};

type DeletePageInput = {
  pageId: string;
  confirmDeleteChildren?: boolean;
};

/**
 * Native, space-scoped MCP (Model Context Protocol) backend.
 *
 * The public tool methods below are the module's authorization boundary: every
 * method that touches a space resolves the target's spaceId and runs the
 * SpaceAbilityFactory read check BEFORE calling the backing service. Calling the
 * backing services directly without this check would bypass space membership and
 * leak private spaces, so the guard lives here (and is unit-tested here) rather
 * than in the thin `buildServer` wiring.
 *
 * Write tools (issue #15) follow the same rule and add two more of their own:
 * they re-check the workspace's `settings.ai.mcpWrite` opt-in on every call —
 * not only when registering the tool — and they delegate the page permission
 * check to PageAccessService.validateCanEdit, which is the single place that
 * folds together space membership, page-level restrictions and the fork's page
 * lock.
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
    private readonly pageAccessService: PageAccessService,
    private readonly environmentService: EnvironmentService,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
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
    const ability = await this.spaceAbilityFor(user, spaceId);
    if (ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Page)) {
      throw new ForbiddenException('You do not have access to this space');
    }
    return ability;
  }

  /**
   * SpaceAbilityFactory throws NotFoundException for a non-member (no role in
   * the space). Normalize that to forbidden so a caller can never tell "private
   * space I can't see" from "missing space".
   */
  private async spaceAbilityFor(user: User, spaceId: string) {
    try {
      return await this.spaceAbility.createForUser(user, spaceId);
    } catch {
      throw new ForbiddenException('You do not have access to this space');
    }
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

  // ---- write-side guards ---------------------------------------------------

  /** True when the workspace has opted in to MCP writes (defaults to off). */
  private isWriteEnabled(workspace: Workspace): boolean {
    return (workspace.settings as any)?.ai?.mcpWrite === true;
  }

  /**
   * Second layer of the write gate. `buildServer` already declines to register
   * the write tools when the switch is off, but every write method re-checks so
   * the guarantee holds however the server was built — and so the switch is a
   * true kill switch for connections that are already open.
   */
  private requireWriteEnabled(workspace: Workspace) {
    if (!this.isWriteEnabled(workspace)) {
      throw new ForbiddenException(
        'MCP write access is not enabled for this workspace',
      );
    }
  }

  /**
   * The write authorization boundary. One delegation covers space membership,
   * page-level access restrictions AND the fork's page lock, because the lock is
   * already folded into the underlying edit-permission computation. Deliberately
   * no separate lock check here: a second one would be a second place for lock
   * semantics to drift.
   */
  private async requirePageEdit(page: Page, user: User) {
    try {
      await this.pageAccessService.validateCanEdit(page, user);
    } catch {
      // validateCanEdit throws Forbidden; the space-ability factory underneath
      // throws NotFound for a non-member. Collapse both so the caller cannot
      // distinguish "not allowed" from "not a member".
      throw new ForbiddenException(
        'You do not have permission to edit this page',
      );
    }
  }

  /**
   * PageService.updatePageContent routes content through
   * CollaborationGateway.handleYjsEvent, which is a silent no-op when the
   * collaboration Redis backend is disabled — the promise resolves and nothing
   * is written. Refuse loudly instead of reporting a success that never
   * happened. (The REST API has the same silent no-op; fixing it there would
   * mean editing collaboration code, which this fork keeps untouched.)
   *
   * Only content *updates* go through that path. Page creation writes its ydoc
   * directly in PageService.create, so create needs no such guard.
   */
  private requireCollabContentWrites() {
    if (this.environmentService.isCollabDisableRedis()) {
      throw new ServiceUnavailableException(
        'Page content cannot be written: the collaboration Redis backend is disabled (COLLAB_DISABLE_REDIS=true). Content updates are routed through the collaboration server and would be silently dropped.',
      );
    }
  }

  /**
   * MCP tool arguments are JSON, so content always arrives as a string. For the
   * editor's own document format that string is a serialized ProseMirror node,
   * which PageService expects as an object.
   */
  private parseContent(content: string, format: ContentFormat): string | object {
    if (format !== 'json') return content;
    try {
      return JSON.parse(content);
    } catch {
      throw new BadRequestException(
        'content is not valid JSON. With format="json", pass the editor document as a JSON-encoded ProseMirror node.',
      );
    }
  }

  /** Compact, link-ready summary of a page — what a write tool returns. */
  private pageSummary(page: Page) {
    return {
      id: page.id,
      slugId: page.slugId,
      title: page.title,
      icon: page.icon,
      spaceId: page.spaceId,
      parentPageId: page.parentPageId,
      updatedAt: page.updatedAt,
    };
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

  // ---- write tool implementations -----------------------------------------

  async createPage(user: User, workspace: Workspace, input: CreatePageInput) {
    this.requireWriteEnabled(workspace);

    if (input.parentPageId) {
      // Under a parent page: the caller must be able to edit the parent — the
      // same split gate the web application uses.
      const parentPage = await this.requirePageInWorkspace(
        input.parentPageId,
        workspace.id,
      );
      if (parentPage.deletedAt || parentPage.spaceId !== input.spaceId) {
        throw new NotFoundException('Parent page not found');
      }
      await this.requirePageEdit(parentPage, user);
    } else {
      // At the root of a space: space-level page creation ability.
      const ability = await this.spaceAbilityFor(user, input.spaceId);
      if (ability.cannot(SpaceCaslAction.Create, SpaceCaslSubject.Page)) {
        throw new ForbiddenException(
          'You do not have permission to create pages in this space',
        );
      }
    }

    const page = await this.pageService.create(user.id, workspace.id, {
      spaceId: input.spaceId,
      parentPageId: input.parentPageId,
      title: input.title,
      icon: input.icon,
      ...(input.content
        ? {
            content: this.parseContent(input.content, input.format ?? 'markdown'),
            format: input.format ?? 'markdown',
          }
        : {}),
    });

    this.auditService.log({
      event: AuditEvent.PAGE_CREATED,
      resourceType: AuditResource.PAGE,
      resourceId: page.id,
      spaceId: page.spaceId,
      changes: {
        after: { title: getPageTitle(page.title), spaceId: page.spaceId },
      },
    });

    return this.pageSummary(page);
  }

  async updatePage(user: User, workspace: Workspace, input: UpdatePageInput) {
    this.requireWriteEnabled(workspace);

    if (input.content) {
      this.requireCollabContentWrites();
    }

    const page = await this.requirePageInWorkspace(input.pageId, workspace.id);
    await this.requirePageEdit(page, user);

    const updated = await this.pageService.update(
      page,
      {
        pageId: page.id,
        title: input.title,
        icon: input.icon,
        ...(input.content
          ? {
              content: this.parseContent(
                input.content,
                input.format ?? 'markdown',
              ),
              format: input.format ?? 'markdown',
              // Append is the default everywhere: a vague "add this to the
              // page" must never wipe what was already there.
              operation: input.operation ?? 'append',
            }
          : {}),
      },
      user,
    );

    return this.pageSummary(updated);
  }

  async deletePage(user: User, workspace: Workspace, input: DeletePageInput) {
    this.requireWriteEnabled(workspace);

    const page = await this.requirePageInWorkspace(input.pageId, workspace.id);
    await this.requirePageEdit(page, user);

    // Trashing cascades to the whole subtree, so make that a deliberate act:
    // count descendants first and refuse unless the caller confirmed.
    const subtree = await this.pageRepo.getPageAndDescendants(page.id, {
      includeContent: false,
    });
    const descendantCount = Math.max(0, subtree.length - 1);

    if (descendantCount > 0 && !input.confirmDeleteChildren) {
      throw new BadRequestException(
        `This page has ${descendantCount} descendant page(s), which would be moved to the trash with it. Ask the user to confirm, then call delete_page again with confirmDeleteChildren=true.`,
      );
    }

    await this.pageService.removePage(page.id, user.id, workspace.id);

    this.auditService.log({
      event: AuditEvent.PAGE_TRASHED,
      resourceType: AuditResource.PAGE,
      resourceId: page.id,
      spaceId: page.spaceId,
      changes: {
        before: {
          pageId: page.id,
          slugId: page.slugId,
          title: getPageTitle(page.title),
          spaceId: page.spaceId,
        },
      },
    });

    return {
      id: page.id,
      slugId: page.slugId,
      title: page.title,
      trashed: true,
      descendantsTrashed: descendantCount,
    };
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

    // Write tools are registered only when the workspace has opted in, so an
    // assistant in a read-only workspace never proposes an edit it cannot make.
    // The methods themselves re-check the switch (see requireWriteEnabled).
    if (this.isWriteEnabled(workspace)) {
      const contentFormat = z
        .enum(['markdown', 'html', 'json'])
        .optional()
        .describe(
          'Format of `content` (default "markdown"). Use "json" only for a JSON-encoded ProseMirror document, e.g. one you read back from get_page — custom blocks (D2 diagrams, Excalidraw drawings, transclusions) do not survive a Markdown round-trip.',
        );

      server.registerTool(
        'create_page',
        {
          title: 'Create page',
          description:
            'Create a new page in a space the user can write to. Optionally nest it under a parent page and give it a title, an icon (a single emoji) and initial content. Do NOT repeat the title as a top-level heading at the start of the content: the title is a separate field and the page would show it twice. Requires MCP write access to be enabled for the workspace.',
          inputSchema: {
            spaceId: z.string().describe('The id of the space to create in.'),
            parentPageId: z
              .string()
              .optional()
              .describe(
                'Create the page as a child of this page id or slug id. The parent must be in the same space. Omit to create at the root of the space.',
              ),
            title: z.string().optional().describe('The page title.'),
            icon: z
              .string()
              .optional()
              .describe('A single emoji used as the page icon.'),
            content: z
              .string()
              .optional()
              .describe('The initial page body, in the format given below.'),
            format: contentFormat,
          },
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
          },
        },
        (args) => run(() => this.createPage(user, workspace, args)),
      );

      server.registerTool(
        'update_page',
        {
          title: 'Update page',
          description:
            'Update a page the user can edit: change its title and/or icon, and/or add content to its body. `operation` defaults to "append", which is the safe and usual choice for a running log. "prepend" puts the content at the top. "replace" is DESTRUCTIVE — it discards the entire existing body, so use it only when the user has explicitly asked for the page to be rewritten, and prefer format="json" when replacing a page whose content you read earlier (a page never edited since it was created may have no version-history snapshot to roll back to). Title and body are separate: do not start the content with a heading repeating the title. Requires MCP write access to be enabled for the workspace.',
          inputSchema: {
            pageId: z.string().describe('The page id or slug id.'),
            title: z
              .string()
              .optional()
              .describe('New page title. Leave unset to keep the current one.'),
            icon: z
              .string()
              .optional()
              .describe('New page icon (a single emoji).'),
            content: z
              .string()
              .optional()
              .describe(
                'Content to add to the page body. Leave unset to change only the title/icon.',
              ),
            format: contentFormat,
            operation: z
              .enum(['append', 'prepend', 'replace'])
              .optional()
              .describe(
                'How to apply `content`: "append" (default, adds to the end), "prepend" (adds to the top), or "replace" (DESTRUCTIVE — discards the whole existing body).',
              ),
          },
          annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: false,
          },
        },
        (args) => run(() => this.updatePage(user, workspace, args)),
      );

      server.registerTool(
        'delete_page',
        {
          title: 'Delete page',
          description:
            'Move a page to the trash, where it stays restorable for the workspace retention window. Permanent deletion is never available over MCP. Trashing a page also trashes every page nested under it: if the page has children the call is refused and reports how many, and you must confirm with the user before retrying with confirmDeleteChildren=true. Requires MCP write access to be enabled for the workspace.',
          inputSchema: {
            pageId: z.string().describe('The page id or slug id.'),
            confirmDeleteChildren: z
              .boolean()
              .optional()
              .describe(
                'Set to true only after the user has confirmed that the descendant pages should be trashed too.',
              ),
          },
          annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: false,
          },
        },
        (args) => run(() => this.deletePage(user, workspace, args)),
      );
    }

    return server;
  }
}
