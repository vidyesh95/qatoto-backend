import { createSingleFileUpload } from "#src/middleware/upload.js";
import { MAX_PRODUCT_MODEL_BYTES } from "#src/modules/store/catalog/glb.js";

/**
 * Multipart parser for the single `model` field of POST /products/:id/model (Appendix A47).
 *
 * Kept as its own module so this route's contract — field name, cap, error copy — is stated in
 * one place and changing it changes only this file, the way `upload-product-document.ts` does for
 * PDFs. The shared error-branch ladder lives in `upload.ts`.
 *
 * ⚠️ `application/octet-stream` IS ACCEPTED, AND MUST STAY ACCEPTED. Browsers and operating
 * systems do not reliably map `.glb` to `model/gltf-binary`: a seller picking a file in Chrome on
 * Windows sends `application/octet-stream` as often as the registered type. The mimetype is a
 * header the client chose and is not the validation (`upload.ts`); the real check is
 * `validateGlbBytes` reading the container header in the service. Both run, in that order.
 *
 * `MAX_PRODUCT_MODEL_BYTES` is imported rather than re-declared, for the reason the document
 * parser imports `MAX_PAPER_BYTES`: a second constant is a second thing to keep in sync.
 */
export const uploadProductModelFile = createSingleFileUpload({
  fieldName: "model",
  maximumBytes: MAX_PRODUCT_MODEL_BYTES,
  acceptsMediaType: (mediaType) =>
    mediaType === "model/gltf-binary" || mediaType === "application/octet-stream",
  tooLargeMessage: "3D model exceeds the 10 MB size limit.",
  unsupportedMediaTypeMessage: "A product 3D model must be a binary glTF (.glb) file.",
  invalidUploadMessage: "Invalid 3D model upload.",
});
