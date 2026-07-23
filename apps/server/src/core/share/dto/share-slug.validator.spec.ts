import { isReservedShareSlug } from './share-slug.validator';

describe('isReservedShareSlug', () => {
  it.each([
    // UUID (share id shape)
    '018f4b3c-9a1e-7c2b-9c3d-1a2b3c4d5e6f',
    '00000000-0000-0000-0000-000000000000',
    // 10-char lowercase alphanumeric (nanoid `key` shape)
    'x7f3k9p2qa',
    'abcdefghij',
    '0123456789',
    // uppercase variant that lower-cases into the key shape (case-insensitive
    // lookup means it could still shadow a key)
    'ABCDEFGHIJ',
    'X7F3K9P2QA',
  ])('rejects reserved value "%s"', (value) => {
    expect(isReservedShareSlug(value)).toBe(true);
  });

  it.each([
    'acme-docs',
    'acme_docs',
    'docs',
    'my-team-handbook',
    'a1', // too short is handled by MinLength, but shape-wise it's fine
    'abcdefghi', // 9 chars, not the 10-char key shape
    'abcdefghijk', // 11 chars
    'acme-docs1', // 10 chars but contains a hyphen → not pure alnum
    'ACME-DOCS', // contains a hyphen → not the key shape
  ])('allows legitimate slug "%s"', (value) => {
    expect(isReservedShareSlug(value)).toBe(false);
  });

  it('ignores non-string values', () => {
    expect(isReservedShareSlug(undefined)).toBe(false);
    expect(isReservedShareSlug(null)).toBe(false);
    expect(isReservedShareSlug(123)).toBe(false);
  });
});
