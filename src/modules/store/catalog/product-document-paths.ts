/**
 * §21.3. The one place that knows what a product document's download URL looks like.
 *
 * A LEAF OF ITS OWN so the projection and the route share the RULE without sharing a graph —
 * `video-document-paths.ts` exists for the same reason and says so. A projection that built this
 * string itself would drift from the route the day either changed, and the failure mode is a link
 * that 404s rather than anything that raises.
 *
 * ⚠️ A PATH, NEVER A URL. `commerce_product_document` has no `url` column on purpose: the client
 * resolves this against the API base, so every fetch goes back through the eligibility gate and
 * only then gets a five-minute presigned link. Storing an absolute URL anywhere would hand out a
 * capability that outlives the listing's visibility.
 */
export function productDocumentDownloadPath(productSlug: string, documentId: string): string {
  return `/store/products/${encodeURIComponent(productSlug)}/documents/${encodeURIComponent(documentId)}/file`;
}
