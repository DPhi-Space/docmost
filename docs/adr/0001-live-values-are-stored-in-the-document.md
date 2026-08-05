# Live values are stored in the document and refreshed on demand

A Live value writes the resolved PLM text into the page as an ordinary inline node attribute,
rather than resolving the PLM at render time. We chose this because every read path that matters
has no PLM access and must not need any: public shares are rendered to anonymous browsers, PDFs
are rendered server-side by Gotenberg, page history is a snapshot of an old ydoc, and the fork's
offline mode renders from IndexedDB with no network at all. A live-resolved widget would be blank
or broken in all four, and would couple every page render to PLM uptime.

## Consequences

- Values are stale until somebody presses Refresh. That is the requested model, not a defect — it
  is what makes Refresh and Acknowledge mean anything.
- **Nothing is written before the author approves the diff.** Refresh resolves and shows a modal
  diff table; Apply writes. This mirrors the Word add-in, whose preview-before-apply rule exists
  because a batch refresh that silently rewrites a review pack is unreviewable.
- Because Apply has already written the new value, **the yellow marker is a post-Apply
  annotation, not a pending value**. The document always holds the current text. There is no
  `pendingValue` attribute anywhere, and an export is never in an intermediate state.
- Page history is the audit trail for free — Apply and Acknowledge are ordinary content edits.
- Applied values are readable by anyone who can read the page, regardless of PLM access: they are
  in `text_content`, every export format, page history, and the offline cache. Confidentiality
  must therefore be enforced at *who may read or share the page*, never at the node. See
  [ADR-0002](0002-one-workspace-service-token.md).
- Apply is a ydoc write, so it is gated on `editor.isEditable`, on the collab provider having
  actually synced, and on the fork's reachability verdict. Writing attributes into a document
  that has not finished loading is the failure class this fork exists to avoid.
