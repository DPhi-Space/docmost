import {
  Controller,
  Get,
  Inject,
  Logger,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import { FastifyReply, FastifyRequest } from 'fastify';
import { Workspace } from '@docmost/db/types/entity.types';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import {
  ALL_NAMED_THROTTLERS_SKIPPED,
  OIDC_THROTTLER,
} from '../../integrations/throttle/throttler-names';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { SessionService } from '../session/session.service';
import { setAuthCookie } from '../auth/auth.util';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';
import { OidcClient } from './oidc-client';
import { OidcAccountService, parseOidcIdentity } from './oidc-account.service';
import {
  decodeFlowState,
  encodeFlowState,
  OIDC_COOKIE_PATH,
  OIDC_ID_TOKEN_COOKIE,
  OIDC_STATE_COOKIE,
  OIDC_STATE_TTL_MS,
  safeRedirectPath,
} from './oidc-state';

export const OIDC_LOGIN_ERROR_REDIRECT = '/login?oidc_error=1';
const LOGIN_REDIRECT = '/login';
const LOGOUT_FALLBACK_REDIRECT = '/login?logout=1';
const DEFAULT_POST_LOGIN_REDIRECT = '/home';

/**
 * Public by design: none of these routes is behind JwtAuthGuard. Login and
 * callback have their own throttler, looser than /auth/login's, because a whole
 * office behind one address signs in at once. Every failure ends on the login
 * page with a generic error; the reason only goes to the server log.
 */
@SkipThrottle({ ...ALL_NAMED_THROTTLERS_SKIPPED, [OIDC_THROTTLER]: false })
@UseGuards(ThrottlerGuard)
@Controller('oidc')
export class OidcController {
  private readonly logger = new Logger(OidcController.name);

  constructor(
    private readonly oidcClient: OidcClient,
    private readonly oidcAccountService: OidcAccountService,
    private readonly sessionService: SessionService,
    private readonly userRepo: UserRepo,
    private readonly environmentService: EnvironmentService,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  @Get('login')
  async login(
    @Query('redirect') redirect: unknown,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    if (!this.oidcClient.enabled || !this.workspaceOf(req)) {
      return res.redirect(LOGIN_REDIRECT, 302);
    }

    try {
      const request = await this.oidcClient.createAuthorizationRequest();
      const flow = encodeFlowState(
        {
          state: request.state,
          nonce: request.nonce,
          codeVerifier: request.codeVerifier,
          redirect: safeRedirectPath(
            redirect,
            this.environmentService.getAppUrl(),
          ),
          exp: Date.now() + OIDC_STATE_TTL_MS,
        },
        this.environmentService.getAppSecret(),
      );
      res.setCookie(OIDC_STATE_COOKIE, flow, {
        ...this.cookieOptions(),
        expires: new Date(Date.now() + OIDC_STATE_TTL_MS),
      });
      return res.redirect(request.url, 302);
    } catch (err) {
      this.logger.error(`OIDC login could not start: ${errorDetail(err)}`);
      return res.redirect(OIDC_LOGIN_ERROR_REDIRECT, 302);
    }
  }

  @Get('callback')
  async callback(@Req() req: FastifyRequest, @Res() res: FastifyReply) {
    const rawFlow = req.cookies?.[OIDC_STATE_COOKIE];
    res.clearCookie(OIDC_STATE_COOKIE, { path: OIDC_COOKIE_PATH });

    try {
      if (!this.oidcClient.enabled) {
        throw new Error('OIDC is not configured');
      }
      const workspace = this.workspaceOf(req);
      if (!workspace) {
        throw new Error('no workspace for this request');
      }

      const flow = decodeFlowState(
        rawFlow,
        this.environmentService.getAppSecret(),
      );
      if (!flow) {
        throw new Error('state cookie missing, tampered with or expired');
      }

      const { claims, idToken } = await this.oidcClient.completeAuthorization(
        queryStringOf(req),
        flow,
      );
      const identity = parseOidcIdentity(
        claims,
        this.oidcClient.settings.requiredRole,
      );
      const user = await this.oidcAccountService.resolveUser(
        workspace,
        identity,
      );

      const authToken = await this.sessionService.createSessionAndToken(user);
      await this.userRepo.updateLastLogin(user.id, workspace.id);
      this.auditService.log({
        event: AuditEvent.USER_LOGIN,
        resourceType: AuditResource.USER,
        resourceId: user.id,
        metadata: { source: 'oidc' },
      });

      setAuthCookie(res, authToken, this.environmentService);
      res.setCookie(OIDC_ID_TOKEN_COOKIE, idToken, {
        ...this.cookieOptions(),
        expires: this.environmentService.getCookieExpiresIn(),
      });
      const target =
        safeRedirectPath(flow.redirect, this.environmentService.getAppUrl()) ??
        DEFAULT_POST_LOGIN_REDIRECT;
      return res.redirect(target, 302);
    } catch (err) {
      this.logger.warn(`OIDC sign-in refused: ${errorDetail(err)}`);
      return res.redirect(OIDC_LOGIN_ERROR_REDIRECT, 302);
    }
  }

  /**
   * Called after POST /auth/logout has already revoked the Docmost session, so
   * it needs no authentication. It only ever redirects to the provider's own
   * end-session endpoint or to the login page.
   */
  @SkipThrottle({ [OIDC_THROTTLER]: true })
  @Get('logout')
  async logout(@Req() req: FastifyRequest, @Res() res: FastifyReply) {
    // A cross-site page must not be able to end the provider session (or burn
    // the ID token) by linking here.
    const fetchSite = req.headers['sec-fetch-site'];
    if (fetchSite !== undefined && fetchSite !== 'same-origin') {
      return res.redirect(LOGOUT_FALLBACK_REDIRECT, 302);
    }

    const idToken = req.cookies?.[OIDC_ID_TOKEN_COOKIE];
    res.clearCookie(OIDC_ID_TOKEN_COOKIE, { path: OIDC_COOKIE_PATH });

    if (!this.oidcClient.enabled || !idToken) {
      return res.redirect(LOGOUT_FALLBACK_REDIRECT, 302);
    }

    try {
      const endSessionUrl = await this.oidcClient.buildEndSessionUrl(idToken);
      return res.redirect(endSessionUrl ?? LOGOUT_FALLBACK_REDIRECT, 302);
    } catch (err) {
      this.logger.error(
        `OIDC logout could not reach the provider: ${errorDetail(err)}`,
      );
      return res.redirect(LOGOUT_FALLBACK_REDIRECT, 302);
    }
  }

  private workspaceOf(req: FastifyRequest): Workspace | null {
    return ((req.raw as any)?.workspace as Workspace) ?? null;
  }

  private cookieOptions() {
    return {
      httpOnly: true,
      sameSite: 'lax' as const,
      path: OIDC_COOKIE_PATH,
      secure: this.environmentService.isHttps(),
    };
  }
}

function queryStringOf(req: FastifyRequest): string {
  const index = req.url.indexOf('?');
  return index === -1 ? '' : req.url.substring(index);
}

function errorDetail(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    const code = (err as { code?: unknown }).code;
    return [
      err.name,
      code ? `[${String(code)}]` : '',
      err.message,
      cause instanceof Error ? `(cause: ${cause.message})` : '',
    ]
      .filter(Boolean)
      .join(' ');
  }
  return String(err);
}
