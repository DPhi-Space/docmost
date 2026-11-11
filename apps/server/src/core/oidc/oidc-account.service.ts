import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';
import {
  User,
  Workspace,
  WorkspaceInvitation,
} from '@docmost/db/types/entity.types';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { GroupUserRepo } from '@docmost/db/repos/group/group-user.repo';
import { isUserDisabled } from '../../common/helpers';
import { UserRole } from '../../common/helpers/types/permission';
import { validateAllowedEmail } from '../auth/auth.util';
import { getWorkspaceDefaultPageEditMode } from '../workspace/workspace.util';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';

/** Its message is for the server log only; the user sees a generic error. */
export class OidcSignInRefused extends Error {
  name = 'OidcSignInRefused';
}

export interface OidcIdentity {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

export function parseOidcIdentity(
  claims: Record<string, unknown>,
  requiredRole: string | null,
): OidcIdentity {
  const sub = claims.sub;
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new OidcSignInRefused('ID token has no subject');
  }

  if (requiredRole) {
    const roles = claims.roles;
    if (!Array.isArray(roles) || !roles.includes(requiredRole)) {
      throw new OidcSignInRefused(
        `sub ${sub} lacks the required role "${requiredRole}"`,
      );
    }
  }

  // Exactly one '@': validateAllowedEmail reads the domain as split('@')[1],
  // so "a@corp.com@x" would otherwise pass a corp.com restriction.
  const rawEmail = typeof claims.email === 'string' ? claims.email.trim() : '';
  const parts = rawEmail.split('@');
  const email = parts.length === 2 && parts[0] && parts[1] ? rawEmail : null;
  const pick = (value: unknown) =>
    typeof value === 'string' && value.trim() ? value.trim() : null;

  return {
    sub,
    email,
    emailVerified: claims.email_verified === true,
    name: pick(claims.name) ?? pick(claims.preferred_username),
  };
}

/** Bound to one transaction and one workspace. */
export interface OidcAccountStore {
  /** Serialises sign-ins of the same sub until the transaction ends. */
  lockSub(sub: string): Promise<void>;
  /** Deleted and deactivated users included, so they can be refused. */
  findUsersLinkedTo(sub: string): Promise<User[]>;
  /** Every user with this email ignoring case, deactivated and deleted ones included. */
  lockUsersByEmail(email: string): Promise<User[]>;
  findLinkedSubs(userId: string): Promise<string[]>;
  insertLink(userId: string, sub: string): Promise<void>;
  findInvitation(email: string): Promise<WorkspaceInvitation | null>;
  createUser(input: {
    email: string;
    name: string | null;
    invitation: WorkspaceInvitation | null;
  }): Promise<User>;
}

export interface ResolvedOidcUser {
  user: User;
  created: boolean;
  linkedByEmail: boolean;
  invitationId: string | null;
}

/**
 * Every refusal here is deliberate: the provider's `sub` is the identity, an
 * email only ever bootstraps the link once, and nothing reactivates or
 * replaces a disabled account.
 */
export async function resolveOidcUser(
  store: OidcAccountStore,
  workspace: Workspace,
  identity: OidcIdentity,
): Promise<ResolvedOidcUser> {
  const { sub } = identity;

  await store.lockSub(sub);
  const linked = await store.findUsersLinkedTo(sub);
  if (linked.length > 1) {
    throw new OidcSignInRefused(`sub ${sub} is linked to several users`);
  }
  if (linked.length === 1) {
    if (isUserDisabled(linked[0])) {
      throw new OidcSignInRefused(`user ${linked[0].id} is disabled`);
    }
    return {
      user: linked[0],
      created: false,
      linkedByEmail: false,
      invitationId: null,
    };
  }

  if (!identity.email || !identity.emailVerified) {
    throw new OidcSignInRefused(
      `sub ${sub} is not linked and has no verified email`,
    );
  }

  const matches = await store.lockUsersByEmail(identity.email);
  if (matches.length > 1) {
    throw new OidcSignInRefused(
      `${matches.length} users share the email of sub ${sub}`,
    );
  }

  if (matches.length === 1) {
    const user = matches[0];
    if (isUserDisabled(user)) {
      throw new OidcSignInRefused(`user ${user.id} is disabled`);
    }
    const subs = await store.findLinkedSubs(user.id);
    if (subs.some((other) => other !== sub)) {
      throw new OidcSignInRefused(
        `user ${user.id} is already linked to a different sub than ${sub}`,
      );
    }
    if (subs.includes(sub)) {
      return { user, created: false, linkedByEmail: false, invitationId: null };
    }
    await store.insertLink(user.id, sub);
    return { user, created: false, linkedByEmail: true, invitationId: null };
  }

  validateAllowedEmail(identity.email, workspace);
  const invitation = await store.findInvitation(identity.email);
  const user = await store.createUser({
    email: identity.email,
    name: identity.name,
    invitation,
  });
  await store.insertLink(user.id, sub);
  return {
    user,
    created: true,
    linkedByEmail: false,
    invitationId: invitation?.id ?? null,
  };
}

class KyselyOidcAccountStore implements OidcAccountStore {
  constructor(
    private readonly trx: KyselyTransaction,
    private readonly workspace: Workspace,
    private readonly userRepo: UserRepo,
    private readonly groupUserRepo: GroupUserRepo,
  ) {}

  async lockSub(sub: string): Promise<void> {
    const key = `${this.workspace.id}:${sub}`;
    await sql`select pg_advisory_xact_lock(hashtext(${key}))`.execute(this.trx);
  }

  findUsersLinkedTo(sub: string): Promise<User[]> {
    return this.trx
      .selectFrom('users')
      .innerJoin('authAccounts', 'authAccounts.userId', 'users.id')
      .select(
        this.userRepo.baseFields.map((field) => `users.${field}` as const),
      )
      .where('authAccounts.providerUserId', '=', sub)
      .where('authAccounts.workspaceId', '=', this.workspace.id)
      .where('authAccounts.authProviderId', 'is', null)
      .where('authAccounts.deletedAt', 'is', null)
      .where('users.workspaceId', '=', this.workspace.id)
      .execute() as Promise<User[]>;
  }

  lockUsersByEmail(email: string): Promise<User[]> {
    return this.trx
      .selectFrom('users')
      .select(this.userRepo.baseFields)
      .where(sql`LOWER(email)`, '=', sql`LOWER(${email})`)
      .where('workspaceId', '=', this.workspace.id)
      .forUpdate()
      .execute() as Promise<User[]>;
  }

  async findLinkedSubs(userId: string): Promise<string[]> {
    const rows = await this.trx
      .selectFrom('authAccounts')
      .select('providerUserId')
      .where('userId', '=', userId)
      .where('workspaceId', '=', this.workspace.id)
      .where('authProviderId', 'is', null)
      .where('deletedAt', 'is', null)
      .execute();
    return rows.map((row) => row.providerUserId);
  }

  async insertLink(userId: string, sub: string): Promise<void> {
    await this.trx
      .insertInto('authAccounts')
      .values({
        userId,
        providerUserId: sub,
        authProviderId: null,
        workspaceId: this.workspace.id,
      })
      .execute();
  }

  async findInvitation(email: string): Promise<WorkspaceInvitation | null> {
    const invitation = await this.trx
      .selectFrom('workspaceInvitations')
      .selectAll()
      .where(sql`LOWER(email)`, '=', sql`LOWER(${email})`)
      .where('workspaceId', '=', this.workspace.id)
      .forUpdate()
      .executeTakeFirst();
    return invitation ?? null;
  }

  // Mirrors WorkspaceInvitationService.acceptInvitation, minus the password.
  async createUser(input: {
    email: string;
    name: string | null;
    invitation: WorkspaceInvitation | null;
  }): Promise<User> {
    const { email, name, invitation } = input;
    const workspaceId = this.workspace.id;

    const user = await this.userRepo.insertUser(
      {
        name: name ?? email.split('@')[0],
        email,
        emailVerifiedAt: new Date(),
        // insertUser always hashes a password; this one is never disclosed.
        password: randomBytes(32).toString('base64url'),
        hasGeneratedPassword: true,
        role: invitation?.role ?? UserRole.MEMBER,
        invitedById: invitation?.invitedById ?? null,
        workspaceId,
      },
      this.trx,
      { pageEditMode: getWorkspaceDefaultPageEditMode(this.workspace) },
    );

    await this.groupUserRepo.addUserToDefaultGroup(
      user.id,
      workspaceId,
      this.trx,
    );

    if (invitation) {
      if (invitation.groupIds?.length > 0) {
        const groups = await this.trx
          .selectFrom('groups')
          .select('id')
          .where('id', 'in', invitation.groupIds)
          .where('workspaceId', '=', workspaceId)
          .execute();
        if (groups.length > 0) {
          await this.trx
            .insertInto('groupUsers')
            .values(
              groups.map((group) => ({ userId: user.id, groupId: group.id })),
            )
            .onConflict((oc) => oc.columns(['userId', 'groupId']).doNothing())
            .execute();
        }
      }

      await this.trx
        .deleteFrom('workspaceInvitations')
        .where('id', '=', invitation.id)
        .execute();
    }

    return user;
  }
}

@Injectable()
export class OidcAccountService {
  private readonly logger = new Logger(OidcAccountService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly userRepo: UserRepo,
    private readonly groupUserRepo: GroupUserRepo,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  async resolveUser(
    workspace: Workspace,
    identity: OidcIdentity,
  ): Promise<User> {
    const result = await executeTx(this.db, (trx) =>
      resolveOidcUser(
        new KyselyOidcAccountStore(
          trx,
          workspace,
          this.userRepo,
          this.groupUserRepo,
        ),
        workspace,
        identity,
      ),
    );

    if (result.linkedByEmail) {
      this.logger.log(
        `OIDC: linked sub ${identity.sub} to existing user ${result.user.id} by verified email`,
      );
    }

    if (result.created) {
      this.logger.log(
        `OIDC: created user ${result.user.id} for sub ${identity.sub}`,
      );
      this.auditService.log({
        event: AuditEvent.USER_CREATED,
        resourceType: AuditResource.USER,
        resourceId: result.user.id,
        changes: {
          after: {
            name: result.user.name,
            email: result.user.email,
            role: result.user.role,
          },
        },
        metadata: {
          source: 'oidc',
          ...(result.invitationId ? { invitationId: result.invitationId } : {}),
        },
      });
    }

    return result.user;
  }
}
