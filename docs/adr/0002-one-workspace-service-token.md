# One workspace service token, not per-user PLM credentials

All PLM traffic uses a single bearer token held server-side in `PLM_API_TOKEN`, issued to a
dedicated PLM user (`docmost-integration`), never sent to the browser. **This deliberately
contradicts the PLM team's handoff document, which says "prefer per-user tokens"**
([§7](../plm-api-for-docmost.md)) — so the reasoning is recorded here rather than left to be
rediscovered as an apparent oversight.

## Why the handoff's advice does not apply

1. **The PLM has no per-object authorisation.** Its own documentation states the API exposes the
   whole workspace to whoever holds a token. A per-user token therefore reads *exactly* the same
   data as a service token. It is not a boundary between engineers — only between people who have
   a PLM account and people who do not.
2. **The value ends up in the page regardless.** Per [ADR-0001](0001-live-values-are-stored-in-the-document.md),
   applied text lives in the document, so anyone who can read the page reads the value whether or
   not they could ever authenticate to the PLM. A per-user token would gate only *insert and
   Refresh*, never *read*. Most of the confidentiality it appears to buy is already spent.

## Considered options

- **Per-user tokens** (each user exchanges their own PLM login once) would buy an honest actor in
  the PLM audit trail and the ability to cut off a leaver by deactivating their PLM account. It
  costs a schema change, reversible encryption at rest — which this server has no helper for
  today, its API keys being one-way hashed — a settings UI, and a "connect your PLM account"
  flow. Rejected as ceremony disproportionate to what it actually protects here.
- **A `PlmTokenProvider` seam** so per-user becomes a strategy swap. Rejected as speculative
  generality; the swap is a small module either way.

## Consequences

- Every Docmost user who can edit a page can cause a read of any value in the PLM.
- All PLM audit entries attribute to one account, which is why it must be a dedicated,
  self-describing PLM user rather than a person's login.
- Config carries **two token slots** from day one — the read token above, and an optional
  write-scoped token — because the PLM has a decision on record to split token scopes, and
  anticipating it makes that a config edit instead of a refactor.
