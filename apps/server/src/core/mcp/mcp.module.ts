import { Module } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';
import { SpaceModule } from '../space/space.module';
import { PageModule } from '../page/page.module';
import { CommentModule } from '../comment/comment.module';
import { WorkspaceModule } from '../workspace/workspace.module';
import { SearchModule } from '../search/search.module';

/**
 * Native (non-EE) MCP backend. Imports the feature modules whose services it
 * reuses; SpaceAbilityFactory / WorkspaceAbilityFactory (CaslModule) and the
 * repos (DatabaseModule) are @Global, so they need no explicit import.
 */
@Module({
  imports: [
    SpaceModule,
    PageModule,
    CommentModule,
    WorkspaceModule,
    SearchModule,
  ],
  controllers: [McpController],
  providers: [McpService],
})
export class McpModule {}
