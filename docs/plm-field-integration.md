# PLM field integration — feasibility analysis & implementation handoff

**Status:** investigation only. No code written. This document is the design brief for the
implementation.

**Goal:** replicate (and improve on) the Word plugin: a `/plm` slash command inserts a *field*
into a page that shows a value fetched from the PLM plus a reference to where it came from; a
**Sync** button re-fetches every field on the page and marks the ones whose value changed in
yellow; an **Accept** button turns the yellow ones back into normal text.

**Verdict: entirely feasible, and the editor already has every mechanism required.** No new
editor infrastructure is needed — the work is one new Tiptap node, one React node view, one
slash-menu entry, one server proxy module, and a page-level Sync/Accept control. The only
genuinely load-bearing design decisions are (a) whether the value is *stored in the document* or
*resolved at render time*, and (b) where the "pending, not yet accepted" state lives. Both are
answered below with a recommendation.

---

## 1. What already exists that we reuse

Everything the feature needs has a working precedent in this repo. Nothing below is speculative;
each is a file you can read today.

| Need | Existing precedent | File |
|---|---|---|
| Inline atom node with attributes and a React view | `Status` (a colored badge, `group: inline`, `atom: true`) | [status.ts](packages/editor-ext/src/lib/status.ts) |
| Inline node that *references an external entity* and renders a label + link | `Mention` (`entityType`/`entityId`/`slugId` attrs) | [mention.ts](packages/editor-ext/src/lib/mention.ts) |
| Slash-menu entry | `CommandGroups.basic` array — one object with `title`/`description`/`searchTerms`/`icon`/`command` | [menu-items.ts:65](apps/client/src/features/editor/components/slash-menu/menu-items.ts#L65) |
| Slash entry that calls the API and patches the node afterwards | `insertBaseEmbedBlock` — inserts a placeholder, POSTs, then `tr.setNodeMarkup` on the placeholder | [insert-base-embed.ts](apps/client/src/features/editor/components/base-embed/insert-base-embed.ts) |
| Insert-then-immediately-open-a-picker | `Status`'s `storage.autoOpen` flag, read by the node view on mount | [status.ts:48](packages/editor-ext/src/lib/status.ts#L48) |
| A `#`-style trigger with a search popup | `Mention`'s `Suggestion` plugin + `mention-suggestion.ts` renderer | [mention-suggestion.ts](apps/client/src/features/editor/components/mention/mention-suggestion.ts) |
| Node view that fetches remote data, with loading/error/no-access placeholders | `TransclusionReferenceView` | [transclusion-reference-view.tsx](apps/client/src/features/editor/components/transclusion/transclusion-reference-view.tsx) |
| Getting the live editor from outside the editor (for a header button) | `pageEditorAtom` (jotai), already published by `page-editor.tsx` | [editor-atoms.ts:5](apps/client/src/features/editor/atoms/editor-atoms.ts#L5) |
| Native (non-EE) server module added by this fork | `core/mcp`, `core/personal-space` | [mcp.module.ts](apps/server/src/core/mcp/mcp.module.ts) |
| Background job infrastructure (for phase 2) | BullMQ, already wired | [queue.module.ts](apps/server/src/integrations/queue/queue.module.ts) |

---

## 2. Proposed architecture

### 2.1 The node: `plmField`

A new inline atom node in `packages/editor-ext/src/lib/plm-field.ts`, exported from
[index.ts](packages/editor-ext/src/index.ts), modelled directly on `Status`.

```ts
export const PlmField = Node.create<PlmFieldOptions>({
  name: "plmField",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      // --- the reference (what the Word plugin calls the field code) ---
      source:      { default: "plm" },   // which PLM system; future-proofing for a 2nd source
      objectId:    { default: null },    // stable object id — NOT the part number, see §5.3
      attribute:   { default: null },    // attribute path within the object
      label:       { default: null },    // human-readable, for tooltip/fallback: "PN-1234 · Mass"

      // --- the accepted snapshot (what renders as normal text) ---
      value:       { default: "" },      // display string, exactly as it should appear
      revision:    { default: null },    // PLM-side version/etag of the accepted value
      syncedAt:    { default: null },    // ISO timestamp of the last accept
      acceptedBy:  { default: null },    // userId, for a cheap audit trail

      // --- the pending change (what renders yellow) ---
      pendingValue:    { default: null },
      pendingRevision: { default: null },
      pendingAt:       { default: null },

      // --- error state from the last sync ---
      syncError:   { default: null },    // "gone" | "forbidden" | "error" | null
    };
  },

  renderHTML({ HTMLAttributes }) {
    // Renders the ACCEPTED value. Exports, print and public shares must never
    // show a pending value as if it were accepted.
    return ["span", { "data-type": "plmField", "data-object-id": …, … }, HTMLAttributes.value];
  },

  renderText({ node }) {
    return node.attrs.value ?? "";   // see §4.1 — this is what puts the value in search
  },

  parseHTML() { return [{ tag: 'span[data-type="plmField"]' }]; },
});
```

**The central decision: the value is stored in the document, not resolved at render time.**

This is what makes it a Word-plugin-equivalent rather than a live widget, and it is the right
call here for five concrete reasons:

1. It is the semantics you asked for. "Sync" and "Accept" only mean something if the document
   holds a value that can *become* stale. A live-resolved field is always current and has no
   accept step.
2. **Public shares, exports, print-to-PDF and page history all render with no PLM access.** A
   shared page is viewed by an anonymous browser; a PDF is rendered server-side by Gotenberg; a
   history revision is a snapshot of an old ydoc. None of these can call the PLM, and none of them
   should need PLM credentials.
3. **Page history becomes the audit trail for free.** "Mass changed from 4.2 kg to 4.4 kg on
   2026-03-01, accepted by X" is already recorded because it is an ordinary content edit.
4. It works offline, which this fork cares about a great deal (see `AGENTS.md` → Offline/PWA).
   Values are in the ydoc, so an offline page renders them; sync is simply disabled while the
   server is unreachable.
5. No render-time coupling to PLM uptime or per-viewer PLM permissions.

The cost is that values are stale until somebody syncs. That is precisely the model requested.

### 2.2 Insert flow — the `/plm` command

Add one entry to `CommandGroups.basic` in
[menu-items.ts](apps/client/src/features/editor/components/slash-menu/menu-items.ts) (single
group; `getSuggestionItems` does the fuzzy matching over `title`/`description`/`searchTerms`, so
`searchTerms: ["plm", "field", "value", "part", "parameter"]` makes `/plm`, `/value` and `/field`
all find it):

```ts
{
  title: "PLM value",
  description: "Insert a live value from the PLM.",
  searchTerms: ["plm", "field", "value", "part", "parameter", "spec"],
  icon: IconDatabaseImport,
  command: ({ editor, range }: CommandProps) => {
    editor.chain().focus().deleteRange(range).run();
    openPlmFieldPicker(editor);   // Mantine modal
  },
}
```

`openPlmFieldPicker` opens a modal: search PLM objects → pick an object → pick an attribute →
insert. On insert it does *one* resolve call and writes `value`/`revision`/`syncedAt` straight
into the node, so a freshly inserted field is never in a pending state.

Two viable variants for the picker, and they are not exclusive:

- **Modal (recommended for v1).** Same shape as the existing export/move/lock modals. Easiest to
  build a good two-step search in, easiest to test.
- **`#` suggestion trigger (v2).** A second `Suggestion` plugin with its own `PluginKey`, copied
  from `Mention`. Lets a power user type `#PN-1234.mass` without leaving the keyboard. Worth
  doing once the field set stabilises and people know their part numbers by heart.

### 2.3 Sync and Accept

**Sync** = for every `plmField` node in the current document, batch-resolve its reference, and
where the returned revision differs from the node's `revision`, write `pendingValue` /
`pendingRevision` / `pendingAt` into that node's attributes.

**Accept** = `value ← pendingValue`, `revision ← pendingRevision`, `syncedAt ← now`,
`acceptedBy ← me`, and clear the three `pending*` attributes.

Both are ordinary ProseMirror transactions over node attributes. **Do the whole page in one
transaction** — walk `editor.state.doc.descendants`, collect positions, then a single dispatch:

```ts
const tr = editor.state.tr;
editor.state.doc.descendants((node, pos) => {
  if (node.type.name !== "plmField") return true;
  const fresh = resolved.get(refKey(node.attrs));
  if (!fresh || fresh.revision === node.attrs.revision) return true;
  tr.setNodeMarkup(pos, undefined, { ...node.attrs, pendingValue: fresh.display, … });
  return true;
});
if (tr.docChanged) editor.view.dispatch(tr);
```

One transaction means one Yjs update rather than N, which matters on a spec sheet with a few
hundred fields.

**Where does the pending state live?** This is the second real decision.

| | **A — pending in node attrs (in the ydoc)** | **B — pending client-local (React state / decorations)** |
|---|---|---|
| Survives reload | yes | no |
| Visible to collaborators | yes | no |
| Needs edit rights to *sync* | yes | no |
| Recorded in page history | yes (two steps: proposed, accepted) | only the accept |
| Works on a locked / read-only page | no | yes (review-only) |
| Extra state to manage | none | a store keyed by page + field |

**Recommendation: A.** It matches the Word document semantics (the pending change is part of the
document until somebody accepts it), it lets one person sync and another review and accept, and
it requires no new persistence. The one thing A gives up — being able to *see* staleness on a
page you cannot edit — is better solved by the phase-2 server-side index (§2.6), which can tell
you "3 pages you watch have outdated PLM values" without touching any document.

**Gating (do not skip this).** Sync writes to the document, so it must be refused unless:

- `editor.isEditable` — covers read-only mode, page lock, missing space permission, share routes;
- the collab provider has actually synced — read `yjsSyncedAtom` / `yjsConnectionStatusAtom`
  from [editor-atoms.ts](apps/client/src/features/editor/atoms/editor-atoms.ts). Writing attrs
  into a document that has not yet loaded from the server is the classic way to lose content in
  this codebase, and this fork exists partly because of exactly that class of bug (`AGENTS.md`,
  top section);
- the server is reachable — reuse the fork's `features/offline/reachability.ts` verdict rather
  than `navigator.onLine`, which lies on any machine with a VPN interface up.

**UI placement.**

- A page-level control next to the existing header actions in
  [page-header-menu.tsx](apps/client/src/features/page/components/header/page-header-menu.tsx):
  a **Sync** icon button, and — when `pendingCount > 0` — a pill reading
  *"N values updated — Review · Accept all"*.
- Per-field: the node view renders a popover on click with the reference (object, attribute,
  revision, last synced), a link out to the PLM object, **Accept**, **Keep current value**, and
  **Unlink** (turn into plain text).
- "Keep current value" should record `dismissedRevision` so the same unwanted change does not
  re-flag on every subsequent sync.

### 2.4 Rendering the yellow state

The node view reads its own attrs; no decorations are needed for an atom node:

```tsx
<NodeViewWrapper as="span" data-pending={node.attrs.pendingValue != null}>
  {node.attrs.pendingValue ?? node.attrs.value}
</NodeViewWrapper>
```

with the yellow background in a CSS module keyed on `[data-pending="true"]`. Show the *pending*
value in the editor (that is the point of the review), while `renderHTML` keeps exporting the
*accepted* one.

Note the perf fork in the road: `Status` and `Mention` both use React node views, and that is the
house idiom — start there. But a React node view is a React component instance **per field**, and
a large spec page could carry several hundred. If that measures badly, the escape hatch is to drop
the node view entirely and render from `renderHTML` alone, moving the yellow state to a single
ProseMirror decoration plugin and the popover to one `handleClick` handler. Same schema, same
attrs, no data migration — so this can be deferred safely, but write the node view thin enough
that swapping it is cheap (no per-node React Query calls, no per-node context subscriptions).

### 2.5 Server proxy: `core/plm`

**The browser must not talk to the PLM directly.** A new native module
`apps/server/src/core/plm/` — same shape as `core/mcp`: `plm.module.ts`, `plm.controller.ts`,
`plm.service.ts`, guarded by the existing `JwtAuthGuard`.

Endpoints:

| Endpoint | Body | Returns | Used by |
|---|---|---|---|
| `POST /api/plm/search` | `{ query, type?, cursor? }` | objects `[{ objectId, name, partNumber, type }]` | picker step 1 |
| `POST /api/plm/attributes` | `{ objectId }` | `[{ attribute, label, unit, sample }]` | picker step 2 |
| `POST /api/plm/resolve` | `{ refs: [{ objectId, attribute }] }` | `[{ objectId, attribute, value, display, unit, revision, updatedAt, status }]` | insert + **sync** |

Why the proxy, concretely:

- The PLM credential stays server-side. A browser cannot hold a PLM service token.
- No CORS configuration on the PLM, and the PLM never needs to be reachable from the public
  internet — only from the docmost container.
- One place for caching (Redis is already a dependency), retry, timeout, rate limiting and audit
  logging of who looked up what.
- The client call becomes an ordinary `/api` request, which means it inherits this fork's
  `api-client` error handling, the React Query conventions, and the service worker's
  "`/api/*` passes through untouched" rule (`AGENTS.md` → Offline/PWA). A direct cross-origin
  call to the PLM would sit outside all three.

Configuration: `PLM_BASE_URL` and `PLM_API_TOKEN` through `EnvironmentService` (secrets in env,
like every other integration in this codebase), plus an optional workspace-level enable switch in
the `settings` JSONB (`settings.plm.enabled`) if per-workspace control is wanted — that is
exactly the pattern the fork's MCP feature uses for `settings.ai.mcp`. The server has global
`fetch` available (`undici` is already a dependency); no new HTTP client package is needed.

### 2.6 Phase 2: knowing which pages are stale without opening them

The Word model is "open the document, press update". Docmost can do better, and the infrastructure
is already here.

A `page_plm_refs` table (`page_id`, `workspace_id`, `object_id`, `attribute`, `value`, `revision`,
`updated_at`) maintained by a **repeatable BullMQ job** that reads `pages.content` (the jsonb
mirror of the ydoc) for pages updated since the last scan and re-extracts the `plmField` nodes.

Deliberately a background scan rather than a hook inside
`collaboration/extensions/persistence.extension.ts`: this fork's whole maintenance strategy rests
on not touching the collaboration/persistence path (`AGENTS.md`, first section), and a scan over
`pages.content` gets the same data with zero risk to it.

What the index buys:

- **"Which pages reference PN-1234?"** — the reverse lookup engineering will ask for within a week
  of shipping.
- **Proactive staleness.** The PLM pushes a webhook (or docmost polls a `changed?since=` feed);
  docmost marks the affected pages and notifies watchers. The user opens a page already knowing
  it needs a sync.
- Reporting: how many pages carry outdated values, and which.

**Do not auto-apply values server-side.** It is technically possible — `PageService.updatePageContent`
routes through `CollaborationGateway.handleYjsEvent` — but that path is a documented silent no-op
when `COLLAB_DISABLE_REDIS=true` (`AGENTS.md` → MCP write surface), and, more importantly, writing
values into documents without a human accept is the opposite of the model you asked for. The
server flags; a human accepts in the editor.

---

## 3. What we need from the PLM side

You control the PLM, so these are requests, not constraints. Ordered by how much pain each one
saves.

1. **A batch resolve endpoint.** `POST /values:batch` taking up to ~500 refs and returning all of
   them in one response. Sync must be *one* round trip per page, not one per field.
2. **A monotonic `revision` (or etag) per value.** This is the single most valuable thing on the
   list. Detecting "has this changed?" by comparing display strings is unreliable: float
   formatting drifts, units get added, and a value legitimately changing to the same string
   (recalculated, same result) is indistinguishable from no change. A revision makes the
   comparison exact and makes "you already dismissed this exact revision" possible.
3. **Both a raw `value` and a preformatted `display` string.** Formatting rules (decimals,
   thousands separators, unit suffix, locale) belong in the PLM, where they are consistent with
   every other consumer. Docmost stores and renders `display`, and keeps `value` for anyone who
   later wants to compute with it.
4. **Stable object ids that survive renames.** If part numbers can be re-issued or corrected, do
   not key on them — return an immutable internal id and the current part number separately.
   Docmost keys on the id and *displays* the part number, so a renamed part keeps working and
   shows its new name.
5. **A search endpoint with pagination**, over object name / part number / type, for the picker.
6. **A distinguishable "gone" status.** A deleted, obsoleted or access-revoked reference must come
   back as an explicit status, not as a bare 404 that is indistinguishable from a transient
   failure. The node needs to render *"this reference no longer exists in the PLM"* rather than
   silently keeping a stale number that looks current.
7. **Optional but high value:** a `GET /values/changed?since=<cursor>` feed and/or a webhook to
   `POST /api/plm/webhook` signed with an HMAC. This is what enables §2.6.

**One question to settle before building: whose PLM permissions apply?** The simple design uses a
single service account, which means *any docmost user who can edit a page can read any PLM value
they can name*. If PLM values are access-controlled per user, we need per-user auth (OIDC token
exchange, or per-user PLM API keys stored against the docmost user), which is a substantially
larger build. Decide this early — it changes the server module's shape, not just its config.

---

## 4. Touchpoints — the complete list

### 4.1 Server-side registration is NOT optional

This is the part that is easy to miss and fails quietly. A new node type must be added to the
server's schema list in
[collaboration.util.ts:59](apps/server/src/collaboration/collaboration.util.ts#L59)
(`tiptapExtensions`). Storage itself does not need it — the ydoc is the source of truth and the
server never rewrites it — but three read paths do, and here is exactly what breaks if you skip it:

- **Search silently dies for affected pages.** `onStoreDocument` calls `jsonToText`, which builds
  a schema from `tiptapExtensions` and throws `Unknown node type` — and the call is wrapped in a
  `try/catch` that logs a warning and leaves `textContent = null`
  ([persistence.extension.ts:106-112](apps/server/src/collaboration/extensions/persistence.extension.ts#L106-L112)).
  Every page containing a PLM field drops out of full-text search, with nothing but a log line.
- **Export throws.** `jsonToHtml` at
  [export.service.ts:83](apps/server/src/integrations/export/export.service.ts#L83) is *not*
  wrapped — HTML, Markdown and PDF export of any page containing the node fails outright.
- **DOCX silently drops the field.** The docx path calls `jsonToNode`, which has a
  `stripUnknownNodes` fallback — so the value vanishes from the exported document without an error.

Note also that `renderText` is what puts the value into `text_content`. `Mention` defines it;
`Status` does not — which is consistent with status badge text being absent from search today.
Worth a one-line check against the installed Tiptap version, then define it.

⚠️ `collaboration.util.ts` lives in the collaboration directory this fork otherwise keeps
untouched. The change is one import and one array entry — additive, low conflict risk — but it
*is* a new line in that file, so note it in `AGENTS.md`'s rebase tally when you ship.

**Rejected alternative:** hijacking the existing `mention` node with a new `entityType: "plm"`
would avoid the server change entirely (the ydoc carries unknown attrs fine, and `mention` is
already in the server schema). Rejected because it inherits `Mention`'s backspace-to-`@` handler
and its export serializers, pollutes real mentions in every consumer that switches on
`entityType`, and buys nothing but one avoided line. The fork's D2 feature is schema-neutral
because it reuses `codeBlock`; a PLM field genuinely is a new node type.

### 4.2 Files to add

```
packages/editor-ext/src/lib/plm-field.ts                    # the node
apps/client/src/features/plm/                               # feature module
  ├─ queries/plm-query.ts                                   # React Query hooks over /api/plm/*
  ├─ services/plm-service.ts                                # api-client calls
  ├─ components/plm-field-picker-modal.tsx                  # the /plm insert flow
  ├─ components/plm-sync-control.tsx                        # header Sync button + pending pill
  ├─ components/plm-review-modal.tsx                        # "N values updated" review list
  ├─ sync/collect-fields.ts                                 # doc walk → refs (pure, testable)
  ├─ sync/apply-sync.ts                                     # resolved values → one transaction (pure)
  └─ types.ts
apps/client/src/features/editor/components/plm/
  ├─ plm-field-view.tsx                                     # the node view
  └─ plm-field.module.css                                   # incl. [data-pending="true"] yellow
apps/server/src/core/plm/
  ├─ plm.module.ts  plm.controller.ts  plm.service.ts
  ├─ dto/…
  └─ plm.service.spec.ts
```

Keep `collect-fields.ts` and `apply-sync.ts` **pure** (document JSON in, refs/transaction steps
out). They are the logic worth unit-testing, and they test cleanly with no editor instance — the
same reason this fork keeps `sw/routes.ts` and `canEditWithoutConnection()` pure.

### 4.3 Files to modify

| File | Change |
|---|---|
| [packages/editor-ext/src/index.ts](packages/editor-ext/src/index.ts) | `export * from "./lib/plm-field";` |
| [apps/client/.../extensions/extensions.ts](apps/client/src/features/editor/extensions/extensions.ts) | register `PlmField.configure({ view: PlmFieldView })` in `mainExtensions` |
| [apps/client/.../slash-menu/menu-items.ts](apps/client/src/features/editor/components/slash-menu/menu-items.ts) | one entry in `CommandGroups.basic`; consider adding `"PLM value"` to `TEMPLATE_EXCLUDED_SLASH_ITEMS` in `extensions.ts` if PLM fields make no sense in templates |
| [apps/client/.../header/page-header-menu.tsx](apps/client/src/features/page/components/header/page-header-menu.tsx) | mount `<PlmSyncControl />` |
| [apps/server/src/collaboration/collaboration.util.ts](apps/server/src/collaboration/collaboration.util.ts) | add `PlmField` to `tiptapExtensions` (§4.1) |
| [apps/server/src/core/core.module.ts](apps/server/src/core/core.module.ts) | import `PlmModule` |
| [packages/editor-ext/.../prosemirror-docx/schema.ts](packages/editor-ext/src/lib/prosemirror-docx/schema.ts) | `plmField(state, node) { state.text(node.attrs.value ?? ""); }` — next to the existing `mention`/`status` handlers |
| `apps/server/src/integrations/environment/environment.service.ts` | `getPlmBaseUrl()` / `getPlmApiToken()` |
| client i18n locale files | the new strings |

Markdown export needs nothing: it runs `htmlToMarkdown` (turndown) over the rendered HTML, and a
plain `<span>` degrades to its text content. Verify once, do not assume.

---

## 5. Risks, gaps and things to decide

### 5.1 Concurrency
Two people syncing at once write the same pending values — convergent, harmless. One accepting
while another syncs is last-writer-wins on that node's attrs, which is the correct outcome
either way (both are writing a value the PLM just returned). No mitigation needed; just do not
be surprised by it.

### 5.2 Public shares
Accepted values render on public shared pages, because they live in the document. If PLM values
are commercially sensitive, that is a leak vector that has nothing to do with the PLM's own
permissions. Decide the policy: either accept it (values were pasted into a page somebody chose
to share), or add a workspace setting that suppresses `plmField` rendering on share routes.
Worth raising with whoever owns data classification, not decided by the implementer.

### 5.3 Copy/paste and duplication
Attrs travel with a copied node, so a pasted field keeps working — good. If you later add a
per-node uuid (for the phase-2 index or for deep-linking), regenerate it on paste via the existing
`UniqueID` extension by adding `"plmField"` to its `types` — remembering it is configured in
*both* [extensions.ts](apps/client/src/features/editor/extensions/extensions.ts) and
[collaboration.util.ts](apps/server/src/collaboration/collaboration.util.ts) and the two lists
must agree. v1 does not need an id: sync addresses nodes by position during the doc walk.

### 5.4 Fields inside tables, headings and callouts
An inline node is allowed anywhere inline content is — including table cells, which is where a
spec sheet will actually put them. The slash command is already blocked inside code blocks by
`SlashCommand`'s `allow` predicate. No extra work expected; test the table case explicitly
anyway, because that is the primary use case.

### 5.5 Performance
One resolve call and one transaction per sync keeps the network and CRDT costs flat. The
remaining risk is React node view count — see §2.4 for the escape hatch. Set an expectation now:
what is the largest realistic field count on one page? If the answer is "20", ignore this
entirely. If it is "800", skip the React node view from the start.

### 5.6 Offline
No new work. Values render from the document offline; sync is disabled by the reachability
verdict; pending/accept writes are ordinary document edits and ride the fork's existing
background sync. Just make sure the Sync button is *disabled with a tooltip* rather than failing
with a network error — that is the established pattern for the offline-disabled title editor.

### 5.7 The unit / rounding question
Decide once, in the PLM (§3.3). If docmost formats and the Word plugin formats, the two will
disagree in front of a customer eventually.

---

## 6. Phasing and rough effort

| Phase | Scope | Estimate |
|---|---|---|
| **0 — spike** | The node + slash command + node view, resolving against a hardcoded mock. Prove insert, render, export, print, and that page history shows the change. | 2–3 days |
| **1 — the feature** | `core/plm` proxy, picker modal, page Sync + Accept, header UI, per-field popover, server schema registration, docx serializer, unit tests on the two pure modules. | 1–2 weeks |
| **2 — proactive** | `page_plm_refs` index via BullMQ scan, PLM webhook/changed-feed, "pages with outdated values" surfacing, reverse lookup. | ~1 week |
| **3 — if needed** | Per-user PLM auth, pinned-revision fields ("always show revision B, not latest"), `#` suggestion trigger, bulk accept across pages. | scoped later |

Phase 1 is independently shippable and delivers full Word-plugin parity. Phase 2 is where docmost
beats the Word plugin.

---

## 7. Verification plan

Beyond the usual (`AGENTS.md` → *Verify after any base/dependency change*), this feature needs:

1. **Round trip.** Insert a field, reload, confirm the value persists and the reference is intact.
2. **Export matrix.** A page with fields exports to HTML, Markdown, PDF and DOCX with the accepted
   value present in all four. This is the check that catches a missed server registration — and it
   fails loudly for HTML/PDF and *silently* for DOCX, so check DOCX by opening the file.
3. **Search.** Create a page with a field whose value is a unique nonsense token, then search for
   that token. If it does not come back, `renderText` or the server schema registration is missing.
4. **Sync/accept.** Change a value in the PLM, press Sync, see yellow, press Accept, see normal
   text. Confirm `pages.text_content` updates and page history shows two distinct revisions.
5. **Collaboration.** Two browsers on the same page: A syncs, B sees yellow without reloading;
   B accepts, A sees it settle.
6. **Permissions.** On a locked page and as a space READER, Sync is disabled, not merely failing.
7. **Share route.** A public share of a page with fields renders accepted values, makes zero
   `/api/plm/*` calls, and shows no Sync affordance.
8. **Offline.** With the server unreachable, fields still render, Sync is disabled with a tooltip,
   and nothing throws in the console.
9. **The data-loss reproduction from `AGENTS.md`**, on a page carrying PLM fields. Any feature
   that writes into the ydoc gets this check.
