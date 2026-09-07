// CommentService transitively imports the collaboration module graph (-> lib0,
// ESM), which Jest's transformIgnorePatterns doesn't transform and which is
// irrelevant here. Stub it as a bare DI token, as personal-space.service.spec.ts
// does for SpaceService.
jest.mock('../../collaboration/collaboration.gateway', () => ({
  CollaborationGateway: class CollaborationGateway {},
}));

import { BadRequestException } from '@nestjs/common';
import { CommentService } from './comment.service';

describe('CommentService.resolve', () => {
  const authUser = { id: 'user-1', name: 'Sam Carter' } as any;

  const rootComment = {
    id: 'comment-1',
    pageId: 'page-1',
    spaceId: 'space-1',
    workspaceId: 'ws-1',
    parentCommentId: null,
    resolvedAt: null,
    resolvedById: null,
  } as any;

  function buildService(overrides?: { yjsEventError?: Error }) {
    const commentRepo = {
      updateComment: jest.fn().mockResolvedValue(undefined),
      findById: jest
        .fn()
        .mockImplementation(async (id: string) => ({ ...rootComment, id })),
    };
    const wsService = { emitCommentEvent: jest.fn() };
    const collaborationGateway = {
      handleYjsEvent: jest
        .fn()
        .mockImplementation(async () =>
          overrides?.yjsEventError
            ? Promise.reject(overrides.yjsEventError)
            : undefined,
        ),
    };

    const service = new CommentService(
      commentRepo as any,
      {} as any,
      wsService as any,
      collaborationGateway as any,
      {} as any,
      {} as any,
    );

    return { service, commentRepo, wsService, collaborationGateway };
  }

  it('stamps the resolver and flips the inline mark', async () => {
    const { service, commentRepo, collaborationGateway, wsService } =
      buildService();

    await service.resolve(rootComment, true, authUser);

    const [update, commentId] = commentRepo.updateComment.mock.calls[0];
    expect(commentId).toBe('comment-1');
    expect(update.resolvedById).toBe('user-1');
    expect(update.resolvedAt).toBeInstanceOf(Date);

    expect(collaborationGateway.handleYjsEvent).toHaveBeenCalledWith(
      'resolveCommentMark',
      'page.page-1',
      { commentId: 'comment-1', resolved: true, user: authUser },
    );

    expect(wsService.emitCommentEvent).toHaveBeenCalledWith(
      'space-1',
      'page-1',
      expect.objectContaining({
        operation: 'commentResolved',
        pageId: 'page-1',
      }),
    );
  });

  it('clears the resolver when re-opening', async () => {
    const { service, commentRepo, collaborationGateway } = buildService();

    await service.resolve(
      { ...rootComment, resolvedAt: new Date(), resolvedById: 'user-2' },
      false,
      authUser,
    );

    const [update] = commentRepo.updateComment.mock.calls[0];
    expect(update.resolvedAt).toBeNull();
    expect(update.resolvedById).toBeNull();

    expect(collaborationGateway.handleYjsEvent).toHaveBeenCalledWith(
      'resolveCommentMark',
      'page.page-1',
      expect.objectContaining({ resolved: false }),
    );
  });

  it('refuses to resolve a reply', async () => {
    const { service, commentRepo } = buildService();

    await expect(
      service.resolve(
        { ...rootComment, parentCommentId: 'comment-0' },
        true,
        authUser,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(commentRepo.updateComment).not.toHaveBeenCalled();
  });

  // The mark is a nicety; the resolved state is the row. A collab failure
  // (including COLLAB_DISABLE_REDIS) must not fail the request.
  it('still resolves when the yjs mark update fails', async () => {
    const { service, wsService } = buildService({
      yjsEventError: new Error('no redis'),
    });

    const comment = await service.resolve(rootComment, true, authUser);

    expect(comment.id).toBe('comment-1');
    expect(wsService.emitCommentEvent).toHaveBeenCalled();
  });

  it('returns the re-read comment with its creator and resolver', async () => {
    const { service, commentRepo } = buildService();

    await service.resolve(rootComment, true, authUser);

    expect(commentRepo.findById).toHaveBeenCalledWith('comment-1', {
      includeCreator: true,
      includeResolvedBy: true,
    });
  });
});
