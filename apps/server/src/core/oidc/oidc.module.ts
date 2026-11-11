import { Module } from '@nestjs/common';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { OidcController } from './oidc.controller';
import { OidcClient } from './oidc-client';
import { OidcAccountService } from './oidc-account.service';
import { readOidcSettings } from './oidc.settings';

@Module({
  controllers: [OidcController],
  providers: [
    {
      provide: OidcClient,
      useFactory: (environmentService: EnvironmentService) =>
        new OidcClient(readOidcSettings(), environmentService.getAppUrl()),
      inject: [EnvironmentService],
    },
    OidcAccountService,
  ],
})
export class OidcModule {}
