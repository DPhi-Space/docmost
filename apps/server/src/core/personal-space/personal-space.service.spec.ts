// SpaceService transitively imports the page/collaboration module graph (-> lib0,
// ESM), which Jest's transformIgnorePatterns doesn't transform and which is
// irrelevant here. Stub it as a bare DI token, as mcp.service.spec.ts does.
jest.mock('../space/services/space.service', () => ({
  SpaceService: class SpaceService {},
}));

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PersonalSpaceService, slugBase } from './personal-space.service';

describe('PersonalSpaceService', () => {
  const workspaceId = 'ws-1';
  const user = { id: 'user-1', name: 'Sam Carter', workspaceId } as any;

  /** Workspace with the admin toggle on. */
  const enabledWorkspace = {
    id: workspaceId,
    settings: { spaces: { allowPersonal: true } },
  } as any;

  function buildService(overrides?: {
    existingPersonalSpace?: any;
    takenSlugs?: string[];
  }) {
    const spaceRepo = {
      findPersonalSpace: jest
        .fn()
        .mockResolvedValue(overrides?.existingPersonalSpace),
      slugExists: jest
        .fn()
        .mockImplementation(async (slug: string) =>
          (overrides?.takenSlugs ?? []).includes(slug),
        ),
    };
    const spaceService = {
      createSpace: jest
        .fn()
        .mockImplementation(async (_u, _w, dto) => ({ id: 'space-1', ...dto })),
    };
    const service = new PersonalSpaceService(
      spaceService as any,
      spaceRepo as any,
    );
    return { service, spaceRepo, spaceService };
  }

  describe('create', () => {
    it('creates the space with isPersonal set', async () => {
      const { service, spaceService } = buildService();

      const space = await service.create(user, enabledWorkspace, {
        name: "Sam's space",
      });

      expect(spaceService.createSpace).toHaveBeenCalledWith(
        user,
        workspaceId,
        { name: "Sam's space", slug: 'sams-space' },
        undefined,
        { isPersonal: true },
      );
      expect(space).toMatchObject({ name: "Sam's space" });
    });

    // The whole point of the endpoint: it must NOT require the workspace-level
    // Manage/Space ability, so a MEMBER can reach it. The admin toggle is what
    // replaces that check.
    it('refuses when the workspace toggle is off', async () => {
      const { service, spaceService } = buildService();

      await expect(
        service.create(user, { id: workspaceId, settings: {} } as any, {}),
      ).rejects.toThrow(ForbiddenException);
      expect(spaceService.createSpace).not.toHaveBeenCalled();
    });

    it('refuses a second personal space for the same user', async () => {
      const { service, spaceService } = buildService({
        existingPersonalSpace: { id: 'space-existing' },
      });

      await expect(
        service.create(user, enabledWorkspace, {}),
      ).rejects.toThrow(BadRequestException);
      expect(spaceService.createSpace).not.toHaveBeenCalled();
    });

    it('suffixes the slug when the derived one is taken', async () => {
      const { service, spaceService } = buildService({
        takenSlugs: ['sams-space'],
      });

      await service.create(user, enabledWorkspace, { name: "Sam's space" });

      const slug = spaceService.createSpace.mock.calls[0][2].slug;
      expect(slug).not.toBe('sams-space');
      expect(slug).toMatch(/^sams-space-[a-z0-9]{6}$/);
    });

    it('gives up rather than looping forever when every candidate is taken', async () => {
      const { service, spaceRepo, spaceService } = buildService();
      spaceRepo.slugExists.mockResolvedValue(true);

      await expect(
        service.create(user, enabledWorkspace, { name: 'taken' }),
      ).rejects.toThrow(BadRequestException);
      expect(spaceRepo.slugExists).toHaveBeenCalledTimes(5);
      expect(spaceService.createSpace).not.toHaveBeenCalled();
    });

    it('falls back to a name derived from the user when none is given', async () => {
      const { service, spaceService } = buildService();

      await service.create(user, enabledWorkspace, {});

      expect(spaceService.createSpace.mock.calls[0][2]).toEqual({
        name: "Sam's space",
        slug: 'sams-space',
      });
    });
  });

  describe('findForUser', () => {
    it('returns null rather than undefined when the user has none', async () => {
      const { service } = buildService();
      await expect(service.findForUser(user.id, workspaceId)).resolves.toBeNull();
    });
  });

  describe('slugBase', () => {
    // CreateSpaceDto's constraint. The endpoint generates the slug itself, so
    // nothing else validates it.
    const SPACE_SLUG = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

    it.each([
      ["Sam's space", 'sams-space'],
      ['Zoë Ünicode', 'zoe-unicode'],
      ['  spaced   out  ', 'spaced-out'],
      ['!!!', 'personal'],
      ['a', 'personal'],
      ['', 'personal'],
      ['---leading', 'leading'],
      ['CAPS Name', 'caps-name'],
    ])('%p -> %p', (input, expected) => {
      const slug = slugBase(input);
      expect(slug).toBe(expected);
      expect(slug).toMatch(SPACE_SLUG);
      expect(slug.length).toBeGreaterThanOrEqual(2);
    });

    it('truncates long names without leaving a trailing hyphen', () => {
      const slug = slugBase('x'.repeat(30) + ' ' + 'y'.repeat(30));
      expect(slug.length).toBeLessThanOrEqual(40);
      expect(slug).toMatch(SPACE_SLUG);
      expect(slug.endsWith('-')).toBe(false);
    });
  });
});
