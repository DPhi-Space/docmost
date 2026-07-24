import {
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { SkipTransform } from '../../common/decorators/skip-transform.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { McpService } from './mcp.service';

/**
 * Streamable-HTTP MCP endpoint, mounted at top-level `/mcp` (excluded from the
 * `/api` global prefix in main.ts). Authentication reuses the workspace API-key
 * JWT via JwtAuthGuard, so an MCP client authenticates with
 * `Authorization: Bearer <api-key>` exactly like the REST API.
 *
 * The transport is stateless (`sessionIdGenerator: undefined`): a fresh MCP
 * server + transport is built per request so the per-request principal stays
 * isolated. We hijack the Fastify reply and hand the raw Node req/res to the SDK
 * transport, and bypass the global response transform interceptor.
 */
@Controller('mcp')
@UseGuards(JwtAuthGuard)
export class McpController {
  constructor(private readonly mcpService: McpService) {}

  @Post()
  @SkipTransform()
  async handlePost(
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.handle(req, res, user, workspace);
  }

  @Get()
  @SkipTransform()
  async handleGet(
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.handle(req, res, user, workspace);
  }

  @Delete()
  @SkipTransform()
  async handleDelete(
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.handle(req, res, user, workspace);
  }

  private async handle(
    req: FastifyRequest,
    res: FastifyReply,
    user: User,
    workspace: Workspace,
  ) {
    // Per-request gate on the workspace toggle the settings UI writes. Thrown
    // before hijack() so Nest's exception filter still renders the 403.
    if (!(workspace.settings as any)?.ai?.mcp) {
      throw new ForbiddenException('MCP is not enabled for this workspace');
    }

    const server = this.mcpService.buildServer({ user, workspace });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.raw.on('close', () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);

    // Take over the raw reply so neither Fastify nor Nest also sends a response.
    res.hijack();
    await transport.handleRequest(req.raw, res.raw, req.body);
  }
}
