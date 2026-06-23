CREATE TYPE "public"."image_source" AS ENUM('oauth', 'user');--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "image_source" "image_source";