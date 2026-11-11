import { BadRequestException } from '@nestjs/common';
import {
  OidcAccountStore,
  OidcIdentity,
  OidcSignInRefused,
  parseOidcIdentity,
  resolveOidcUser,
} from './oidc-account.service';

type FakeUser = {
  id: string;
  email: string;
  role: string;
  deactivatedAt: Date | null;
  deletedAt: Date | null;
  groups: string[];
};

/** In-memory stand-in for one workspace's users, links and invitations. */
class MemoryStore implements OidcAccountStore {
  users: FakeUser[] = [];
  links: { userId: string; sub: string }[] = [];
  invitations: any[] = [];
  createdWith: any[] = [];
  lockedSubs: string[] = [];

  addUser(partial: Partial<FakeUser> & { id: string; email: string }) {
    const user: FakeUser = {
      role: 'member',
      deactivatedAt: null,
      deletedAt: null,
      groups: [],
      ...partial,
    };
    this.users.push(user);
    return user;
  }

  async lockSub(sub: string) {
    this.lockedSubs.push(sub);
  }

  async findUsersLinkedTo(sub: string) {
    const ids = this.links.filter((l) => l.sub === sub).map((l) => l.userId);
    return this.users.filter((u) => ids.includes(u.id)) as any[];
  }

  async lockUsersByEmail(email: string) {
    return this.users.filter(
      (u) => u.email.toLowerCase() === email.toLowerCase(),
    ) as any[];
  }

  async findLinkedSubs(userId: string) {
    return this.links.filter((l) => l.userId === userId).map((l) => l.sub);
  }

  async insertLink(userId: string, sub: string) {
    this.links.push({ userId, sub });
  }

  async findInvitation(email: string) {
    return (
      this.invitations.find(
        (i) => i.email.toLowerCase() === email.toLowerCase(),
      ) ?? null
    );
  }

  async createUser(input: {
    email: string;
    name: string | null;
    invitation: any;
  }) {
    this.createdWith.push(input);
    const user = this.addUser({
      id: `new-${this.users.length + 1}`,
      email: input.email.toLowerCase(),
      role: input.invitation?.role ?? 'member',
      groups: ['default', ...(input.invitation?.groupIds ?? [])],
    });
    if (input.invitation) {
      this.invitations = this.invitations.filter(
        (i) => i.id !== input.invitation.id,
      );
    }
    return user as any;
  }
}

const workspace = { id: 'ws-1', emailDomains: [] } as any;

const identity = (overrides: Partial<OidcIdentity> = {}): OidcIdentity => ({
  sub: 'sub-alice',
  email: 'alice@example.com',
  emailVerified: true,
  name: 'Alice',
  ...overrides,
});

describe('resolveOidcUser', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  describe('linking', () => {
    it('signs in the user already linked to the sub, whatever the email says', async () => {
      store.addUser({ id: 'u1', email: 'old-address@example.com' });
      store.links.push({ userId: 'u1', sub: 'sub-alice' });

      const result = await resolveOidcUser(store, workspace, identity());

      expect(result.user.id).toBe('u1');
      expect(result.created).toBe(false);
      expect(store.links).toHaveLength(1);
    });

    it('links an existing user by verified email, ignoring case', async () => {
      store.addUser({ id: 'u1', email: 'Alice@Example.com' });

      const result = await resolveOidcUser(store, workspace, identity());

      expect(result.user.id).toBe('u1');
      expect(result.created).toBe(false);
      expect(result.linkedByEmail).toBe(true);
      expect(store.links).toEqual([{ userId: 'u1', sub: 'sub-alice' }]);
    });

    it('takes the per-sub lock before any lookup', async () => {
      store.findUsersLinkedTo = jest.fn(async () => {
        expect(store.lockedSubs).toEqual(['sub-alice']);
        return [];
      });

      await resolveOidcUser(store, workspace, identity());
      expect(store.findUsersLinkedTo).toHaveBeenCalled();
    });

    it('does not link or create on an unverified email', async () => {
      store.addUser({ id: 'u1', email: 'alice@example.com' });

      await expect(
        resolveOidcUser(store, workspace, identity({ emailVerified: false })),
      ).rejects.toBeInstanceOf(OidcSignInRefused);
      expect(store.links).toHaveLength(0);
      expect(store.createdWith).toHaveLength(0);
    });

    it('does not create a user from an unverified email either', async () => {
      await expect(
        resolveOidcUser(store, workspace, identity({ emailVerified: false })),
      ).rejects.toBeInstanceOf(OidcSignInRefused);
      expect(store.createdWith).toHaveLength(0);
    });

    it('refuses when no email is present', async () => {
      await expect(
        resolveOidcUser(store, workspace, identity({ email: null })),
      ).rejects.toBeInstanceOf(OidcSignInRefused);
    });

    it('refuses when two users share the email', async () => {
      store.addUser({ id: 'u1', email: 'alice@example.com' });
      store.addUser({ id: 'u2', email: 'ALICE@example.com' });

      await expect(
        resolveOidcUser(store, workspace, identity()),
      ).rejects.toBeInstanceOf(OidcSignInRefused);
      expect(store.links).toHaveLength(0);
    });

    it('counts a deactivated namesake as a match, so two matches still refuse', async () => {
      store.addUser({ id: 'u1', email: 'alice@example.com' });
      store.addUser({
        id: 'u2',
        email: 'Alice@example.com',
        deactivatedAt: new Date(),
      });

      await expect(
        resolveOidcUser(store, workspace, identity()),
      ).rejects.toBeInstanceOf(OidcSignInRefused);
    });

    it('refuses when the email user is already linked to a different sub', async () => {
      store.addUser({ id: 'u1', email: 'alice@example.com' });
      store.links.push({ userId: 'u1', sub: 'sub-somebody-else' });

      await expect(
        resolveOidcUser(store, workspace, identity()),
      ).rejects.toBeInstanceOf(OidcSignInRefused);
      expect(store.links).toHaveLength(1);
    });

    it('does not add a duplicate link when a concurrent sign-in linked the same sub first', async () => {
      const user = store.addUser({ id: 'u1', email: 'alice@example.com' });
      // The sub lookup ran before the other transaction committed its link.
      store.findUsersLinkedTo = async () => [];
      store.links.push({ userId: user.id, sub: 'sub-alice' });

      const result = await resolveOidcUser(store, workspace, identity());

      expect(result.user.id).toBe('u1');
      expect(store.links).toHaveLength(1);
    });

    it('refuses a sub linked to several users', async () => {
      store.addUser({ id: 'u1', email: 'a@example.com' });
      store.addUser({ id: 'u2', email: 'b@example.com' });
      store.links.push({ userId: 'u1', sub: 'sub-alice' });
      store.links.push({ userId: 'u2', sub: 'sub-alice' });

      await expect(
        resolveOidcUser(store, workspace, identity()),
      ).rejects.toBeInstanceOf(OidcSignInRefused);
    });
  });

  describe('disabled and deleted users', () => {
    it('refuses a deactivated user found by sub', async () => {
      store.addUser({
        id: 'u1',
        email: 'alice@example.com',
        deactivatedAt: new Date(),
      });
      store.links.push({ userId: 'u1', sub: 'sub-alice' });

      await expect(
        resolveOidcUser(store, workspace, identity()),
      ).rejects.toBeInstanceOf(OidcSignInRefused);
      expect(store.createdWith).toHaveLength(0);
    });

    it('refuses a deactivated user found by email, and never creates a replacement', async () => {
      store.addUser({
        id: 'u1',
        email: 'alice@example.com',
        deactivatedAt: new Date(),
      });

      await expect(
        resolveOidcUser(store, workspace, identity()),
      ).rejects.toBeInstanceOf(OidcSignInRefused);
      expect(store.links).toHaveLength(0);
      expect(store.createdWith).toHaveLength(0);
    });

    it('refuses a deleted user through the link deleteUser keeps, and never re-creates them', async () => {
      // The state WorkspaceService.deleteUser leaves: email rewritten, so the
      // email lookup misses; the native link (authProviderId NULL) survives.
      store.addUser({
        id: 'u1',
        email: '2f0c3a52-0000-4000-8000-000000000000@deleted.docmost.com',
        deletedAt: new Date(),
      });
      store.links.push({ userId: 'u1', sub: 'sub-alice' });

      await expect(
        resolveOidcUser(store, workspace, identity()),
      ).rejects.toBeInstanceOf(OidcSignInRefused);
      expect(store.createdWith).toHaveLength(0);
      expect(store.links).toHaveLength(1);
    });
  });

  describe('creating members', () => {
    it('creates a member in the default group and links the sub', async () => {
      const result = await resolveOidcUser(store, workspace, identity());

      expect(result.created).toBe(true);
      expect(result.invitationId).toBeNull();
      expect(result.user.role).toBe('member');
      expect((result.user as any).groups).toEqual(['default']);
      expect(store.createdWith[0]).toMatchObject({
        email: 'alice@example.com',
        name: 'Alice',
        invitation: null,
      });
      expect(store.links).toEqual([
        { userId: result.user.id, sub: 'sub-alice' },
      ]);
    });

    it('honours a pending invitation: its role and groups, and it is consumed', async () => {
      store.invitations.push({
        id: 'inv-1',
        email: 'Alice@example.com',
        role: 'admin',
        groupIds: ['g-eng'],
        invitedById: 'owner-1',
      });

      const result = await resolveOidcUser(store, workspace, identity());

      expect(result.created).toBe(true);
      expect(result.invitationId).toBe('inv-1');
      expect(result.user.role).toBe('admin');
      expect((result.user as any).groups).toEqual(['default', 'g-eng']);
      expect(store.invitations).toHaveLength(0);
    });

    it('enforces the workspace email domains', async () => {
      const restricted = { ...workspace, emailDomains: ['corp.example'] };

      await expect(
        resolveOidcUser(store, restricted, identity()),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(store.createdWith).toHaveLength(0);
    });

    it('does not apply email domains to an existing user being linked', async () => {
      store.addUser({ id: 'u1', email: 'alice@example.com' });
      const restricted = { ...workspace, emailDomains: ['corp.example'] };

      const result = await resolveOidcUser(store, restricted, identity());
      expect(result.user.id).toBe('u1');
    });
  });
});

describe('parseOidcIdentity', () => {
  const claims = {
    sub: 'sub-alice',
    email: 'alice@example.com',
    email_verified: true,
    name: 'Alice Liddell',
    preferred_username: 'alice',
    roles: ['user'],
  };

  it('reads sub, email, verification and name', () => {
    expect(parseOidcIdentity(claims, null)).toEqual({
      sub: 'sub-alice',
      email: 'alice@example.com',
      emailVerified: true,
      name: 'Alice Liddell',
    });
  });

  it('falls back to preferred_username for the name', () => {
    const { name, ...rest } = claims;
    expect(parseOidcIdentity(rest, null).name).toBe('alice');
  });

  it.each(['a@corp.com@x.example', 'no-at-sign', '@corp.com', 'alice@'])(
    'treats the malformed email %p as absent',
    (email) => {
      expect(parseOidcIdentity({ ...claims, email }, null).email).toBeNull();
    },
  );

  it('treats only a boolean true as a verified email', () => {
    expect(
      parseOidcIdentity({ ...claims, email_verified: 'true' }, null)
        .emailVerified,
    ).toBe(false);
  });

  it('accepts a token carrying the required role', () => {
    expect(parseOidcIdentity(claims, 'user').sub).toBe('sub-alice');
  });

  it.each([
    ['missing', undefined],
    ['without the role', ['viewer']],
    ['a string instead of an array', 'user'],
    ['null', null],
  ])('refuses a roles claim that is %s', (_label, roles) => {
    expect(() => parseOidcIdentity({ ...claims, roles }, 'user')).toThrow(
      OidcSignInRefused,
    );
  });

  it('ignores roles entirely when no role is required', () => {
    expect(parseOidcIdentity({ ...claims, roles: undefined }, null).sub).toBe(
      'sub-alice',
    );
  });

  it('refuses a token without a subject', () => {
    expect(() => parseOidcIdentity({ ...claims, sub: '' }, null)).toThrow(
      OidcSignInRefused,
    );
  });
});
