/**
 * The two facts about attached documents that BOTH domains need, in a module that imports nothing.
 *
 * ⚠️ WHY IT IS ITS OWN FILE, AND WHY IT MUST STAY THAT WAY. `video-watch.service.ts` — a HOME read,
 * on the public watch payload — needs the download path so it can project a document row. Reaching
 * into `videos.service.ts` for it works and is what shipped first, but that file is 2,600 lines and
 * its import graph pulls in `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `cloudinary`,
 * `sharp` and the pg-boss job registry. Loading all of that on the public feed path, to build one
 * string, is the kind of coupling that stays invisible until something is slow and nobody knows why.
 *
 * `src/modules/studio/public-video-gate.ts` is the precedent and the argument: a rule several
 * domains must agree on gets a leaf of its own, so they share the rule without sharing a graph.
 *
 * DO NOT ADD A DATABASE READ, A CONFIG LOOKUP OR AN IMPORT HERE. The moment this file needs one it
 * stops being a leaf and the coupling comes back through it.
 */

/** How many documents one video may carry. "Deck or whitepaper" is not a file manager. */
export const MAX_VIDEO_DOCUMENTS = 5;

/**
 * `/videos/:videoId/documents/:documentId/file` — the route that re-checks the video's public gate
 * and then 302s to a short-lived presigned URL.
 *
 * ONE PLACE, so the route declaration and the two projections that publish it cannot drift apart.
 * It is a path on this API, never a link to the bytes: see the `videoDocument` schema comment for
 * why storing a URL would be a regression rather than a shortcut.
 */
export function videoDocumentDownloadPath(videoId: string, documentId: string): string {
  return `/videos/${encodeURIComponent(videoId)}/documents/${encodeURIComponent(documentId)}/file`;
}
