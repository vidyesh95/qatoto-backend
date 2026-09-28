import type { Result } from "#src/types/index.js";

/**
 * Parses a creator's transcript file — SubRip (.srt), WebVTT (.vtt) or plain text — into segments.
 *
 * ⚠️ **THE FORMAT IS INFERRED FROM THE BYTES, NEVER TAKEN FROM THE CLIENT.** This is the one route
 * whose whole job is parsing untrusted text, so a declared format would be a claim to distrust
 * rather than an input to use: a .vtt renamed .srt would parse to garbage, or refuse at a line
 * number that does not match what the creator sees. `WEBVTT` on the first line means vtt; a
 * `00:00:01,000 -->` line anywhere means srt; anything else is plain text.
 *
 * ⚠️ **THE LIMITS ARE ONE CONSISTENT SET, AND THE FILE CAP IS THE REAL CEILING.** The upload is
 * capped at {@link MAX_TRANSCRIPT_FILE_BYTES} by multer. Within that, a cue or paragraph may hold
 * {@link MAX_TRANSCRIPT_SEGMENT_CHARACTERS} characters and a file {@link MAX_TRANSCRIPT_SEGMENTS}
 * cues — about sixteen hours at three seconds a cue, so the count is a backstop against
 * pathological one-word cues rather than the thing that stops a long lecture. Every file under the
 * byte cap reaches this parser, so every refusal below can name its line.
 *
 * NO DEPENDENCY. The two formats are small and line-oriented, and a library would be a larger
 * surface than the parse it replaces on the one input here that is entirely attacker-controlled.
 */

/** Multer's cap on the upload. The frontend checks the same number before sending. */
export const MAX_TRANSCRIPT_FILE_BYTES = 1024 * 1024; // 1 MB

/** Characters in one cue or paragraph. `video_transcript_segment_text_ck` holds the same bound. */
export const MAX_TRANSCRIPT_SEGMENT_CHARACTERS = 2000;

/** Cues in one file. */
export const MAX_TRANSCRIPT_SEGMENTS = 20_000;

export type TranscriptFormat = "srt" | "vtt" | "text";

export interface ParsedTranscriptSegment {
  readonly startOffsetSeconds: number;
  /** Set for every srt/vtt cue, NULL for a pasted-text paragraph, which carries no timing. */
  readonly endOffsetSeconds: number | null;
  readonly segmentText: string;
}

export interface ParsedTranscript {
  readonly format: TranscriptFormat;
  readonly segments: readonly ParsedTranscriptSegment[];
}

/** Why a file was refused. `line` is 1-based and null when the problem is the file as a whole. */
export interface TranscriptParseError {
  readonly line: number | null;
  readonly message: string;
}

interface NumberedLine {
  readonly lineNumber: number;
  readonly text: string;
}

const SRT_TIMING_DETECTOR = /^\s*\d{1,2}:\d{2}:\d{2},\d{3}\s*-->/;
const SRT_TIMING_LINE =
  /^\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})\s*$/;
// WebVTT allows the hours to be omitted and settings (`align:start` …) after the end time.
const VTT_TIMING_LINE =
  /^\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})\.(\d{3})(?:\s+.*)?$/;
const VTT_METADATA_BLOCK = /^(NOTE|STYLE|REGION)(\s|$)/;

const MARKUP_TAG = /<[^>]*>/g;
// ASS-style overrides some SRT exporters leave behind, e.g. `{\an8}`.
const OVERRIDE_BLOCK = /\{\\[^}]*\}/g;

function toWholeSeconds(hours: string | undefined, minutes: string, seconds: string): number {
  return Number(hours ?? "0") * 3600 + Number(minutes) * 60 + Number(seconds);
}

function decodeBasicEntities(text: string): string {
  return text
    .replaceAll("&nbsp;", " ")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

/** Joins a cue's lines, strips formatting, collapses whitespace. May return "". */
function cleanCueText(cueLines: readonly NumberedLine[]): string {
  const joined = cueLines.map((cueLine) => cueLine.text).join(" ");
  return decodeBasicEntities(joined.replace(OVERRIDE_BLOCK, "").replace(MARKUP_TAG, ""))
    .replace(/\s+/g, " ")
    .trim();
}

/** Splits into blocks separated by blank lines, keeping each line's 1-based number. */
function splitIntoBlocks(lines: readonly string[]): NumberedLine[][] {
  const blocks: NumberedLine[][] = [];
  let currentBlock: NumberedLine[] = [];
  lines.forEach((text, index) => {
    if (text.trim() === "") {
      if (currentBlock.length > 0) blocks.push(currentBlock);
      currentBlock = [];
      return;
    }
    currentBlock.push({ lineNumber: index + 1, text });
  });
  if (currentBlock.length > 0) blocks.push(currentBlock);
  return blocks;
}

function detectFormat(lines: readonly string[]): TranscriptFormat {
  if (/^WEBVTT(\s|$)/.test(lines[0] ?? "")) return "vtt";
  if (lines.some((line) => SRT_TIMING_DETECTOR.test(line))) return "srt";
  return "text";
}

function tooLongError(lineNumber: number, kind: "cue" | "paragraph"): TranscriptParseError {
  return {
    line: lineNumber,
    message: `Line ${String(lineNumber)}: this ${kind} is longer than ${MAX_TRANSCRIPT_SEGMENT_CHARACTERS.toLocaleString("en-US")} characters. Split it into shorter ${kind}s.`,
  };
}

function tooManyError(lineNumber: number): TranscriptParseError {
  return {
    line: lineNumber,
    message: `Line ${String(lineNumber)}: a transcript can hold at most ${MAX_TRANSCRIPT_SEGMENTS.toLocaleString("en-US")} lines.`,
  };
}

function parseTimedBlocks(
  blocks: readonly NumberedLine[][],
  format: "srt" | "vtt",
): Result<ParsedTranscriptSegment[], TranscriptParseError> {
  const timingLinePattern = format === "srt" ? SRT_TIMING_LINE : VTT_TIMING_LINE;
  const timingExample =
    format === "srt" ? "00:01:02,000 --> 00:01:05,000" : "00:01:02.000 --> 00:01:05.000";
  const segments: ParsedTranscriptSegment[] = [];

  // A vtt file's first block is its `WEBVTT` header, which carries no cue.
  const cueBlocks = format === "vtt" ? blocks.slice(1) : blocks;

  for (const block of cueBlocks) {
    const [firstLine] = block;
    if (firstLine === undefined) continue;
    if (format === "vtt" && VTT_METADATA_BLOCK.test(firstLine.text)) continue;

    // The timing line is the first line, or the second when the cue has an identifier/number.
    const timingLineIndex = block.findIndex((blockLine) => blockLine.text.includes("-->"));
    const timingLine = timingLineIndex === -1 ? undefined : block[timingLineIndex];
    if (timingLine === undefined || timingLineIndex > 1) {
      return {
        success: false,
        error: {
          line: firstLine.lineNumber,
          message: `Line ${String(firstLine.lineNumber)}: expected a timestamp like ${timingExample}.`,
        },
      };
    }

    const timingMatch = timingLinePattern.exec(timingLine.text);
    if (timingMatch === null) {
      return {
        success: false,
        error: {
          line: timingLine.lineNumber,
          message: `Line ${String(timingLine.lineNumber)}: expected a timestamp like ${timingExample}.`,
        },
      };
    }

    const [
      ,
      startHours,
      startMinutes = "0",
      startSeconds = "0",
      ,
      endHours,
      endMinutes = "0",
      endSeconds = "0",
    ] = timingMatch;
    const startOffsetSeconds = toWholeSeconds(startHours, startMinutes, startSeconds);
    const endOffsetSeconds = toWholeSeconds(endHours, endMinutes, endSeconds);
    if (endOffsetSeconds < startOffsetSeconds) {
      return {
        success: false,
        error: {
          line: timingLine.lineNumber,
          message: `Line ${String(timingLine.lineNumber)}: this cue ends before it starts.`,
        },
      };
    }

    const segmentText = cleanCueText(block.slice(timingLineIndex + 1));
    // A cue whose text is empty once formatting is stripped carries nothing to read.
    if (segmentText === "") continue;
    if (segmentText.length > MAX_TRANSCRIPT_SEGMENT_CHARACTERS) {
      return { success: false, error: tooLongError(timingLine.lineNumber, "cue") };
    }
    if (segments.length >= MAX_TRANSCRIPT_SEGMENTS) {
      return { success: false, error: tooManyError(timingLine.lineNumber) };
    }

    segments.push({ startOffsetSeconds, endOffsetSeconds, segmentText });
  }

  return { success: true, value: segments };
}

function parseTextBlocks(
  blocks: readonly NumberedLine[][],
): Result<ParsedTranscriptSegment[], TranscriptParseError> {
  const segments: ParsedTranscriptSegment[] = [];
  for (const block of blocks) {
    const [firstLine] = block;
    if (firstLine === undefined) continue;
    const segmentText = block
      .map((blockLine) => blockLine.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (segmentText === "") continue;
    if (segmentText.length > MAX_TRANSCRIPT_SEGMENT_CHARACTERS) {
      return { success: false, error: tooLongError(firstLine.lineNumber, "paragraph") };
    }
    if (segments.length >= MAX_TRANSCRIPT_SEGMENTS) {
      return { success: false, error: tooManyError(firstLine.lineNumber) };
    }
    segments.push({ startOffsetSeconds: 0, endOffsetSeconds: null, segmentText });
  }
  return { success: true, value: segments };
}

export function parseTranscriptFile(
  fileBytes: Uint8Array,
): Result<ParsedTranscript, TranscriptParseError> {
  let decodedText: string;
  try {
    decodedText = new TextDecoder("utf-8", { fatal: true }).decode(fileBytes);
  } catch {
    return {
      success: false,
      error: {
        line: null,
        message: "This file is not UTF-8 text. Save it as UTF-8 and try again.",
      },
    };
  }

  // Postgres `text` cannot hold a NUL byte; refusing here is a 422 instead of a 500.
  if (decodedText.includes("\0")) {
    return {
      success: false,
      error: { line: null, message: "This file contains binary data, not text." },
    };
  }

  const lines = decodedText.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  const format = detectFormat(lines);
  const blocks = splitIntoBlocks(lines);

  const segmentsResult =
    format === "text" ? parseTextBlocks(blocks) : parseTimedBlocks(blocks, format);
  if (!segmentsResult.success) return segmentsResult;

  if (segmentsResult.value.length === 0) {
    return {
      success: false,
      error: { line: null, message: "No transcript text was found in this file." },
    };
  }

  return { success: true, value: { format, segments: segmentsResult.value } };
}
