import { WorkspaceService } from '../workspace/services/workspace.service';
import { UserRole } from '../../common/helpers/types/permission';

// Deleting a member must keep their native OIDC link (authProviderId NULL):
// deleteUser rewrites the email, so the link is the only thing left that lets
// the next SSO sign-in find the deleted user and refuse instead of creating a
// fresh account.
describe('WorkspaceService.deleteUser and OIDC links', () => {
  const workspaceId = 'ws-1';
  const userId = 'user-1';

  it('deletes only provider-backed auth_accounts rows', async () => {
    const deletes: { table: string; wheres: unknown[][] }[] = [];
    const trx = {
      deleteFrom: jest.fn((table: string) => {
        const record = { table, wheres: [] as unknown[][] };
        deletes.push(record);
        const builder = {
          where: (...args: unknown[]) => {
            record.wheres.push(args);
            return builder;
          },
          execute: jest.fn(),
        };
        return builder;
      }),
    };
    const db = {
      transaction: () => ({ execute: (cb: (t: any) => any) => cb(trx) }),
    };
    const userRepo = {
      findById: jest.fn().mockResolvedValue({
        id: userId,
        role: UserRole.MEMBER,
        deactivatedAt: null,
        deletedAt: null,
      }),
      updateUser: jest.fn(),
    };
    const byUser = () => ({ deleteByUserAndWorkspace: jest.fn() });

    const service = new WorkspaceService(
      { findById: jest.fn().mockResolvedValue({ id: workspaceId }) } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      userRepo as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      byUser() as any,
      byUser() as any,
      db as any,
      { add: jest.fn() } as any,
      {} as any,
      {} as any,
      { log: jest.fn() } as any,
      { revokeByUserId: jest.fn() } as any,
      { deleteUserConnections: jest.fn() } as any,
      { disconnectUser: jest.fn() } as any,
      { recheckAccess: jest.fn() } as any,
    );

    await service.deleteUser(
      { id: 'admin-1', role: UserRole.ADMIN } as any,
      userId,
      workspaceId,
    );

    const authAccounts = deletes.filter((d) => d.table === 'authAccounts');
    expect(authAccounts).toHaveLength(1);
    expect(authAccounts[0].wheres).toEqual([
      ['userId', '=', userId],
      ['authProviderId', 'is not', null],
    ]);
  });
});
