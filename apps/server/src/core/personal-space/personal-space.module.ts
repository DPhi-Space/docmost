import { Module } from '@nestjs/common';
import { PersonalSpaceController } from './personal-space.controller';
import { PersonalSpaceService } from './personal-space.service';
import { SpaceModule } from '../space/space.module';

/**
 * Native (non-EE) personal-space backend. Imports SpaceModule for SpaceService;
 * the repos (DatabaseModule) are @Global and need no explicit import.
 */
@Module({
  imports: [SpaceModule],
  controllers: [PersonalSpaceController],
  providers: [PersonalSpaceService],
})
export class PersonalSpaceModule {}
