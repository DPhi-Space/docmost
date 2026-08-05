# The as-of pin is a per-node attribute, not a page-level property

A Live value carries its own `asOf`. "Pin this page to the CDR baseline" is one transaction
writing that attribute onto every Live value in the document, and the page banner describing the
pin is **derived by walking nodes, never stored**. **This deliberately contradicts the PLM team's
handoff, which calls the pin "a document-level property" and says to store it on the page**
([§5.5](../plm-api-for-docmost.md)).

## Why

1. **The resolve API is already per-ref.** A ref may carry its own `as_of`, and `"as_of": null`
   forces a live read even under a batch pin. Per-node maps 1:1 onto the contract with no
   translation layer.
2. **It is the only honest way to represent the two non-faithful Kinds.** `status` and `metadata`
   keep no value history, so the PLM silently returns *current* values under a pin. As per-node
   attributes those Live values are written with `asOf: null` — which the PLM honours as an
   explicit live read — and rendered with a persistent "live — not pinned" marker. A page-level
   flag would have to lie about two of the six Kinds, producing a review pack showing historical
   masses beside today's build status with nothing on screen saying so. That is precisely the
   plausible-but-wrong failure the `#ERROR` sentinel rule exists to prevent.
3. **No schema change.** `pages` has no metadata or settings JSONB column, so a page-level pin
   would mean a migration or a new table; a ProseMirror document attribute would mean a schema
   change the server's extension list would also have to agree with.
4. **Copy/paste stays correct.** This is the same principle that puts the Reference and the Cache
   on the node: a Live value pasted into another page is immediately self-describing. Under a
   page-level pin, pasting a pinned value into an unpinned page would silently make it live.

## Consequences

- A page may be *mixed* — some values pinned, others live. This is useful (one table held at the
  baseline, the prose current) but the banner must say "mixed" honestly rather than pretending to
  a single state.
- There is no authoritative row saying "this page is pinned"; anything that wants to know walks
  the document.
- An unparseable pin degrades to a live read at the PLM and is never an error, so the pin date is
  validated client-side — otherwise a typo silently unpins a document that claims to be pinned.
