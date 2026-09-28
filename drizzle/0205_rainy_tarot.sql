CREATE TYPE "public"."video_transcript_format" AS ENUM('srt', 'vtt', 'text');--> statement-breakpoint
CREATE TABLE "video_transcript" (
	"video_id" text PRIMARY KEY NOT NULL,
	"format" "video_transcript_format" NOT NULL,
	"segment_count" integer NOT NULL,
	"uploaded_at" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "video_transcript_segment_count_ck" CHECK (segment_count > 0)
);
--> statement-breakpoint
CREATE TABLE "video_transcript_segment" (
	"video_id" text NOT NULL,
	"segment_order" integer NOT NULL,
	"start_offset_seconds" integer NOT NULL,
	"end_offset_seconds" integer,
	"segment_text" text NOT NULL,
	CONSTRAINT "video_transcript_segment_video_id_segment_order_pk" PRIMARY KEY("video_id","segment_order"),
	CONSTRAINT "video_transcript_segment_offsets_ck" CHECK (segment_order >= 0
          AND start_offset_seconds >= 0
          AND (end_offset_seconds IS NULL OR end_offset_seconds >= start_offset_seconds)),
	CONSTRAINT "video_transcript_segment_text_ck" CHECK (char_length(segment_text) BETWEEN 1 AND 2000)
);
--> statement-breakpoint
ALTER TABLE "video_transcript" ADD CONSTRAINT "video_transcript_video_id_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_transcript_segment" ADD CONSTRAINT "video_transcript_segment_video_id_video_transcript_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."video_transcript"("video_id") ON DELETE cascade ON UPDATE no action;