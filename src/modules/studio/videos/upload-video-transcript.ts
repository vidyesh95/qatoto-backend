import { MAX_TRANSCRIPT_FILE_BYTES } from "#src/lib/subtitle-parse.js";
import { createSingleFileUpload } from "#src/middleware/upload.js";

/**
 * Multipart parser for the single `transcript` field of `PUT /videos/:videoId/transcript`.
 *
 * ⚠️ MULTIPART RATHER THAN JSON, AND THE REASON IS THE BODY CEILING. `json-body.ts` parses JSON
 * once, globally, at 128 KB, and no per-route JSON cap can exceed that; a long lecture's .srt can.
 * Multer owns this stream instead, so the transcript's real ceiling is `MAX_TRANSCRIPT_FILE_BYTES`
 * — the same number the parser's own limits are sized against. Pasted text arrives the same way,
 * wrapped as a file by the browser, so there is one path.
 *
 * THE MIMETYPE GATE IS DELIBERATELY LOOSE. Browsers label a .srt as `application/x-subrip`,
 * `text/plain`, `application/octet-stream` or nothing at all depending on the OS, and refusing
 * any of those would refuse a correct file. The bytes decide: `parseTranscriptFile` insists on
 * strict UTF-8 with no NUL bytes and infers the format itself.
 */
const ACCEPTED_TRANSCRIPT_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "",
  "application/octet-stream",
  "application/x-subrip",
]);

export const uploadVideoTranscriptFile = createSingleFileUpload({
  fieldName: "transcript",
  maximumBytes: MAX_TRANSCRIPT_FILE_BYTES,
  acceptsMediaType: (mediaType) =>
    mediaType.startsWith("text/") || ACCEPTED_TRANSCRIPT_MEDIA_TYPES.has(mediaType),
  tooLargeMessage: "That transcript is over the 1 MB limit.",
  unsupportedMediaTypeMessage: "A transcript must be a .srt, .vtt or plain text file.",
  invalidUploadMessage: "That transcript could not be read. Send one text file.",
  textFieldLimit: 0,
  fieldErrorKey: "transcript",
});
