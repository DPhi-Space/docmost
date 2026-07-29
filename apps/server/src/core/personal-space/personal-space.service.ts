import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { SpaceService } from '../space/services/space.service';
import { SpaceRepo } from '@docmost/db/repos/space/space.repo';
import { Space, User, Workspace } from '@docmost/db/types/entity.types';
import { generateSlugId } from '../../common/helpers/nanoid.utils';
import { CreatePersonalSpaceDto } from './dto/create-personal-space.dto';
import { CreateSpaceDto } from '../space/dto/create-space.dto';

/** Max attempts at a unique slug before giving up (base + 4 suffixed). */
const SLUG_ATTEMPTS = 5;

/**
 * Native (non-EE) personal-space backend.
 *
 * A personal space is an ordinary space row with `is_personal = true`; nothing
 * downstream (permissions, search, shares, MCP, export) reads that column. The
 * only thing this module adds is *who may create a space*: `spaces/create`
 * requires the workspace-level `Manage Space` ability, which MEMBERs do not
 * have, so without this endpoint a member can never own a space.
 *
 * The two guards that replace that ability check are the per-workspace
 * `settings.spaces.allowPersonal` toggle (admin-controlled, default off) and
 * the `spaces_personal_creator_unique` partial index (one per creator).
 *
 * Licensing is *not* re-checked here, matching the fork's MCP module: the
 * Feature.PERSONAL_SPACES gate lives on the write of the workspace toggle
 * (workspace.service.ts), so an unlicensed workspace can never turn it on.
 */
@Injectable()
export class PersonalSpaceService {
  constructor(
    private readonly spaceService: SpaceService,
    private readonly spaceRepo: SpaceRepo,
  ) {}

  async findForUser(
    userId: string,
    workspaceId: string,
  ): Promise<Space | null> {
    const space = await this.spaceRepo.findPersonalSpace(userId, workspaceId);
    return space ?? null;
  }

  async create(
    user: User,
    workspace: Workspace,
    dto: CreatePersonalSpaceDto,
  ): Promise<Space> {
    if ((workspace.settings as any)?.spaces?.allowPersonal !== true) {
      throw new ForbiddenException(
        'Personal spaces are disabled for this workspace',
      );
    }

    // Checked here for a readable error; the unique index is what actually
    // guarantees it under concurrent requests.
    const existing = await this.spaceRepo.findPersonalSpace(
      user.id,
      workspace.id,
    );
    if (existing) {
      throw new BadRequestException('You already have a personal space');
    }

    const name = dto?.name?.trim() || defaultSpaceName(user);
    const slug = await this.generateSlug(name, workspace.id);

    return this.spaceService.createSpace(
      user,
      workspace.id,
      { name, slug } as CreateSpaceDto,
      undefined,
      { isPersonal: true },
    );
  }

  /**
   * The create modal has no slug field, so the server derives one. Personal
   * space names collide constantly ("Sam's space" in a workspace with two
   * Sams), hence the suffixed retries.
   */
  private async generateSlug(
    name: string,
    workspaceId: string,
  ): Promise<string> {
    const base = slugBase(name);

    for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt++) {
      const candidate =
        attempt === 0
          ? base
          : `${base}-${generateSlugId().toLowerCase().slice(0, 6)}`;

      if (!(await this.spaceRepo.slugExists(candidate, workspaceId))) {
        return candidate;
      }
    }

    throw new BadRequestException(
      'Could not generate a unique space slug. Please try a different name',
    );
  }
}

/** Used when the request omits a name; never empty. */
function defaultSpaceName(user: User): string {
  const firstName = (user?.name ?? '').trim().split(/\s+/)[0];
  return firstName ? `${firstName}'s space` : 'Personal space';
}

/**
 * Produces a slug matching CreateSpaceDto's `/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/`
 * (2..100 chars): accents folded via NFKD and the resulting combining marks
 * dropped (leaving them turns "Ünicode" into "u-nicode", since a combining
 * mark is not alphanumeric), apostrophes removed so "Sam's space" reads
 * "sams-space" rather than "sam-s-space", every other run collapsed to a
 * single hyphen, and both ends trimmed so it can never start or end with one.
 */
export function slugBase(name: string): string {
  const slug = (name ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .toLowerCase()
    .slice(0, 40)
    .replace(/^-+|-+$/g, '');

  return slug.length >= 2 ? slug : 'personal';
}
