import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { PersonalSpaceService } from './personal-space.service';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { CreatePersonalSpaceDto } from './dto/create-personal-space.dto';

@UseGuards(JwtAuthGuard)
@Controller('personal-space')
export class PersonalSpaceController {
  constructor(private readonly personalSpaceService: PersonalSpaceService) {}

  /**
   * The caller's own personal space, or null. Deliberately not gated on the
   * workspace toggle: turning the toggle off stops new personal spaces being
   * created, it does not hide the one a user already owns (which is also the
   * behaviour the client's top menu expects).
   */
  @HttpCode(HttpStatus.OK)
  @Post('info')
  async info(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.personalSpaceService.findForUser(user.id, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('create')
  async create(
    @Body() dto: CreatePersonalSpaceDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.personalSpaceService.create(user, workspace, dto);
  }
}
