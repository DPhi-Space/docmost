/**
 * Pure decision logic for the diagram save paths, shared by the drawio menu
 * and the Excalidraw save seam (`features/offline/offline-uploads.ts`) and
 * kept out of both so it is unit testable without mounting an editor or a
 * diagram embed.
 *
 * Both node types overwrite their attachment **in place** on save, which is
 * what makes a dangling pointer fatal for them and merely cosmetic for images
 * and other read-only attachments (those just render broken).
 */

/**
 * Does this upload failure mean "the attachment you asked me to overwrite is
 * not there" — as opposed to a refusal we must report?
 *
 * Copying a page to another space mints a **new** attachment id for every
 * diagram (both drawio and Excalidraw) and rewrites the node to it, then
 * copies the files in a best-effort loop whose per-attachment failures are
 * only written to the server log
 * (`page.service.ts`, upstream `//TODO: best to handle this in a queue`). A
 * copied page can therefore point at an id that was never created, and the
 * server answers the overwrite with 404 `Existing attachment to overwrite not
 * found` (`attachment.service.ts`). The 400 twin — `File attachment does not
 * match` — is a node whose attachment belongs to a different page, which is
 * what copy-pasting a diagram node between pages produces. Either way the
 * diagram is permanently unsaveable, and upstream reports neither to the user.
 *
 * Both are repaired identically: upload as a NEW attachment and re-point the
 * node. Nothing is destroyed — an attachment that does exist stays with
 * whichever page owns it, and the repair is idempotent because the second save
 * overwrites an id this page owns.
 *
 * Matched narrowly on the server's own message: a size limit, a generic
 * `Error processing file upload.`, a 403 from the fork's page lock or any
 * transport failure must still fail loudly rather than quietly forking a
 * second attachment. Every field is optional-chained — `err.response` is
 * undefined for every transport-level failure.
 */
export function isMissingOverwriteTarget(err: unknown): boolean {
  const response = (
    err as { response?: { status?: number; data?: { message?: unknown } } }
  )?.response;
  const message = String(response?.data?.message ?? "").toLowerCase();

  if (response?.status === 404) {
    return message.includes("existing attachment to overwrite not found");
  }
  if (response?.status === 400) {
    return message.includes("file attachment does not match");
  }
  return false;
}
