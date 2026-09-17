import { withCodSpeed } from "@codspeed/tinybench-plugin";
import { Bench } from "tinybench";

import {
  extractYoutubeVideoId,
  isYoutubeVideoUrl,
  sanitizeYoutubeThumbnailUrl,
} from "#src/lib/youtube.js";
import { BENCHMARK_OPTIONS, MICRO_BENCHMARK_REPEATS } from "#src/test-support/bench-fixtures.js";

/**
 * The Studio upload flow's parser, which is a SECURITY BOUNDARY before it is a convenience: every
 * link a creator submits is parsed here, and the id it returns is the only thing downstream ever
 * handles.
 *
 * It is worth measuring because the shapes it accepts do very different amounts of work. A bare
 * 11-character id returns from a single regex test. Everything else constructs a `URL`, which is
 * the expensive step, and a `watch?v=` link additionally builds `searchParams`. The corpus below
 * keeps all of those shapes in one benchmark in their real proportions, plus the rejections —
 * lookalike hosts and unparseable strings — because a parser that gets slower at saying no is a
 * parser that can be made to cost the server something.
 */

const CREATOR_SUBMITTED_URLS: readonly string[] = [
  "dQw4w9WgXcQ",
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL9tY0BWXOZFtA1L5&index=4&t=87s",
  "https://youtu.be/dQw4w9WgXcQ",
  "https://youtu.be/dQw4w9WgXcQ?t=42",
  "https://www.youtube.com/shorts/dQw4w9WgXcQ",
  "https://www.youtube.com/embed/dQw4w9WgXcQ",
  "https://www.youtube.com/live/dQw4w9WgXcQ",
  "www.youtube.com/watch?v=dQw4w9WgXcQ",
  "  https://m.youtube.com/watch?v=dQw4w9WgXcQ  ",
  // Rejections: a lookalike host, a path that is not a video, a non-video scheme, and junk.
  "https://youtube.com.evil.tld/watch?v=dQw4w9WgXcQ",
  "https://www.youtube.com/@some-channel",
  "javascript:alert(1)",
  "not a url at all",
];

const THUMBNAIL_URL_SHAPES: readonly string[] = [
  "https://i.ytimg.com/vi/VIDEO_ID/hqdefault.jpg",
  "https://i9.ytimg.com/vi/VIDEO_ID/maxresdefault.jpg?sqp=-oaymwEc&rs=AOn4CLB",
  "https://www.youtube.com/vi/VIDEO_ID/0.jpg",
  "http://i.ytimg.com/vi/VIDEO_ID/hqdefault.jpg",
  "https://ytimg.com.evil.tld/vi/VIDEO_ID/hqdefault.jpg",
  "definitely-not-a-url",
];

/** Ten distinct ids per shape, so the corpus is 60 payloads rather than 6 cached ones. */
const PROVIDER_THUMBNAIL_URLS: readonly string[] = Array.from(
  { length: 10 },
  (unusedValue, idIndex) =>
    THUMBNAIL_URL_SHAPES.map((shape) => shape.replace("VIDEO_ID", `dQw4w9WgXc${String(idIndex)}`)),
).flat();

const WATCH_LINK_WITH_QUERY =
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL9tY0BWXOZFtA1L5&index=4&t=87s";

export const youtubeBenchmarks = withCodSpeed(new Bench({ name: "youtube", ...BENCHMARK_OPTIONS }));

youtubeBenchmarks.add("extractYoutubeVideoId over a mixed submission corpus", () => {
  for (const rawUrl of CREATOR_SUBMITTED_URLS) {
    extractYoutubeVideoId(rawUrl);
  }
});

youtubeBenchmarks.add("extractYoutubeVideoId — 1000 bare ids (the fast path)", () => {
  for (let repeat = 0; repeat < MICRO_BENCHMARK_REPEATS; repeat += 1) {
    extractYoutubeVideoId("dQw4w9WgXcQ");
  }
});

youtubeBenchmarks.add("extractYoutubeVideoId — 1000 watch links with query parameters", () => {
  for (let repeat = 0; repeat < MICRO_BENCHMARK_REPEATS; repeat += 1) {
    extractYoutubeVideoId(WATCH_LINK_WITH_QUERY);
  }
});

youtubeBenchmarks.add("isYoutubeVideoUrl over a mixed submission corpus", () => {
  for (const rawUrl of CREATOR_SUBMITTED_URLS) {
    isYoutubeVideoUrl(rawUrl);
  }
});

youtubeBenchmarks.add("sanitizeYoutubeThumbnailUrl over 60 provider payloads", () => {
  for (const rawThumbnailUrl of PROVIDER_THUMBNAIL_URLS) {
    sanitizeYoutubeThumbnailUrl(rawThumbnailUrl);
  }
});
