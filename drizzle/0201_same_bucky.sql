ALTER TABLE "problem_submission" ADD COLUMN "approx_latitude_microdegrees" integer;--> statement-breakpoint
ALTER TABLE "problem_submission" ADD COLUMN "approx_longitude_microdegrees" integer;--> statement-breakpoint
ALTER TABLE "problem_submission" ADD CONSTRAINT "problem_submission_approx_coordinate_ck" CHECK ((approx_latitude_microdegrees IS NULL
           OR approx_latitude_microdegrees BETWEEN -90000000 AND 90000000)
          AND (approx_longitude_microdegrees IS NULL
               OR approx_longitude_microdegrees BETWEEN -180000000 AND 180000000)
          AND (approx_latitude_microdegrees IS NULL) = (approx_longitude_microdegrees IS NULL));