import { AuthenticationExtension } from './authentication.extension';

// The fork's page lock reaches collaboration only through canUserEditPage,
// which reports a locked page as a restriction the user may read but not
// edit. These cases pin that getAccess still turns that shape into a
// read-only connection for a space writer.
async function authenticateWriter(lockShape: {
  hasAnyRestriction: boolean;
  canAccess: boolean;
  canEdit: boolean;
}) {
  const subscriber = {
    on: jest.fn(),
    subscribe: jest.fn(async () => undefined),
    disconnect: jest.fn(),
  };
  const extension = new AuthenticationExtension(
    { verifyJwt: jest.fn(async () => ({ sub: 'user_1', workspaceId: 'ws_1' })) } as any,
    { findById: jest.fn(async (id: string) => ({ id, workspaceId: 'ws_1' })) } as any,
    {
      findById: jest.fn(async (id: string) => ({
        id,
        spaceId: 'space_1',
        workspaceId: 'ws_1',
        deletedAt: null,
      })),
    } as any,
    {
      getUserSpaceRoles: jest.fn(async () => [{ userId: 'user_1', role: 'writer' }]),
    } as any,
    { canUserEditPage: jest.fn(async () => lockShape) } as any,
    { getOrThrow: () => ({ duplicate: () => subscriber }) } as any,
  );
  await extension.onConfigure({ instance: { documents: new Map() } } as any);

  const payload = {
    documentName: 'page.page_1',
    token: 'token',
    connectionConfig: { readOnly: false },
  } as any;
  await extension.onAuthenticate(payload);
  return payload.connectionConfig.readOnly;
}

describe('AuthenticationExtension and the page lock', () => {
  it('opens a locked page read-only for a space writer', async () => {
    await expect(
      authenticateWriter({ hasAnyRestriction: true, canAccess: true, canEdit: false }),
    ).resolves.toBe(true);
  });

  it('leaves an unlocked page writable for a space writer', async () => {
    await expect(
      authenticateWriter({ hasAnyRestriction: false, canAccess: true, canEdit: true }),
    ).resolves.toBe(false);
  });
});
