import { describe, expect, it } from "vitest";

import { MAX_TRANSCRIPT_SEGMENT_CHARACTERS, parseTranscriptFile } from "#src/lib/subtitle-parse.js";

function toBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("subtitle-parse", () => {
  describe("encoding and binary safety (500 error prevention)", () => {
    it("rejects non-UTF8 byte sequences with descriptive error", () => {
      // Invalid UTF-8 sequence (isolated continuation byte)
      const invalidUtf8Bytes = new Uint8Array([0xff, 0xfe, 0x80]);
      const result = parseTranscriptFile(invalidUtf8Bytes);

      expect(result).toEqual({
        success: false,
        error: {
          line: null,
          message: "This file is not UTF-8 text. Save it as UTF-8 and try again.",
        },
      });
    });

    it("rejects binary files containing NUL bytes before reaching Postgres", () => {
      const bytesWithNul = toBytes("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\u0000World");
      const result = parseTranscriptFile(bytesWithNul);

      expect(result).toEqual({
        success: false,
        error: {
          line: null,
          message: "This file contains binary data, not text.",
        },
      });
    });
  });

  describe("WebVTT parsing", () => {
    it("parses valid WebVTT cues, ignores metadata blocks, and decodes HTML entities", () => {
      const vttContent = `WEBVTT

NOTE This is a note that should be ignored

1
00:00:01.000 --> 00:00:04.500
Hello <b>world</b> &amp; welcome to &quot;Qatoto&quot;!

2
00:01:05.200 --> 00:01:10.000 line:0 position:20%
Second cue text here.`;

      const result = parseTranscriptFile(toBytes(vttContent));

      expect(result).toEqual({
        success: true,
        value: {
          format: "vtt",
          segments: [
            {
              startOffsetSeconds: 1,
              endOffsetSeconds: 4,
              segmentText: 'Hello world & welcome to "Qatoto"!',
            },
            {
              startOffsetSeconds: 65,
              endOffsetSeconds: 70,
              segmentText: "Second cue text here.",
            },
          ],
        },
      });
    });

    it("rejects cues where end time is before start time", () => {
      const vttContent = `WEBVTT

00:00:10.000 --> 00:00:05.000
Backward timing cue.`;

      const result = parseTranscriptFile(toBytes(vttContent));

      expect(result).toEqual({
        success: false,
        error: {
          line: 3,
          message: "Line 3: this cue ends before it starts.",
        },
      });
    });
  });

  describe("SRT parsing", () => {
    it("parses valid SubRip cues and removes ASS override tags", () => {
      const srtContent = `1
00:00:02,000 --> 00:00:05,000
{\\an8}First subtitle line.

2
00:00:06,500 --> 00:00:09,000
Second subtitle line with <font color="blue">color</font>.`;

      const result = parseTranscriptFile(toBytes(srtContent));

      expect(result).toEqual({
        success: true,
        value: {
          format: "srt",
          segments: [
            {
              startOffsetSeconds: 2,
              endOffsetSeconds: 5,
              segmentText: "First subtitle line.",
            },
            {
              startOffsetSeconds: 6,
              endOffsetSeconds: 9,
              segmentText: "Second subtitle line with color.",
            },
          ],
        },
      });
    });

    it("rejects invalid timing line formats in SRT", () => {
      const srtContent = `1
00:00:01,000 --> 00:00:04,000
Valid first cue.

2
00:00:05,000 --> invalid-timestamp
Second cue with broken timestamp.`;

      const result = parseTranscriptFile(toBytes(srtContent));

      expect(result).toEqual({
        success: false,
        error: {
          line: 6,
          message: "Line 6: expected a timestamp like 00:01:02,000 --> 00:01:05,000.",
        },
      });
    });
  });

  describe("Plain text parsing", () => {
    it("parses plain text paragraphs into segments with null endOffsetSeconds", () => {
      const textContent = `First paragraph of the transcript.

Second paragraph of the transcript with multiple lines
wrapped together.`;

      const result = parseTranscriptFile(toBytes(textContent));

      expect(result).toEqual({
        success: true,
        value: {
          format: "text",
          segments: [
            {
              startOffsetSeconds: 0,
              endOffsetSeconds: null,
              segmentText: "First paragraph of the transcript.",
            },
            {
              startOffsetSeconds: 0,
              endOffsetSeconds: null,
              segmentText: "Second paragraph of the transcript with multiple lines wrapped together.",
            },
          ],
        },
      });
    });

    it("rejects an empty plain text file", () => {
      const result = parseTranscriptFile(toBytes("   \n\n   "));

      expect(result).toEqual({
        success: false,
        error: {
          line: null,
          message: "No transcript text was found in this file.",
        },
      });
    });

    it("rejects a paragraph exceeding maximum segment character limits", () => {
      const oversizedText = "x".repeat(MAX_TRANSCRIPT_SEGMENT_CHARACTERS + 10);
      const result = parseTranscriptFile(toBytes(oversizedText));

      expect(result).toEqual({
        success: false,
        error: {
          line: 1,
          message: expect.stringContaining("longer than 2,000 characters"),
        },
      });
    });
  });
});
