ALTER TABLE "showcase_launch" DROP CONSTRAINT "showcase_launch_call_to_action_ck";--> statement-breakpoint
ALTER TABLE "showcase_launch" ADD CONSTRAINT "showcase_launch_call_to_action_ck" CHECK ((call_to_action_label IS NULL AND call_to_action_url IS NULL)
          OR (call_to_action_label IS NOT NULL
              AND call_to_action_url IS NOT NULL
              AND char_length(call_to_action_label) BETWEEN 1 AND 40
              AND char_length(call_to_action_url) BETWEEN 1 AND 2048
              AND call_to_action_url LIKE 'https://%'
              AND call_to_action_url !~ '[[:space:][:cntrl:]]'));