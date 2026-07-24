import { Module } from '@nestjs/common';
import { TemplateController } from './template.controller';
import { TemplateService } from './services/template.service';
import { PageModule } from '../page/page.module';

@Module({
  // PageModule exports PageService, which `/templates/use` reuses to
  // instantiate a page from a template's content. TemplateRepo, SpaceMemberRepo
  // (DatabaseModule) and the CASL ability factories (CaslModule) are global.
  imports: [PageModule],
  controllers: [TemplateController],
  providers: [TemplateService],
  exports: [TemplateService],
})
export class TemplateModule {}
