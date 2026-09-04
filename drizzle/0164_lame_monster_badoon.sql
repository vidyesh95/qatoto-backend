ALTER TABLE "localization_pathway_suggestion" ADD COLUMN "estimated_capital_min_in_cents" bigint;--> statement-breakpoint
ALTER TABLE "localization_pathway_suggestion" ADD COLUMN "estimated_capital_max_in_cents" bigint;--> statement-breakpoint
ALTER TABLE "localization_pathway_suggestion" ADD COLUMN "capital_basis_text" text;--> statement-breakpoint
ALTER TABLE "localization_pathway_suggestion" ADD CONSTRAINT "localization_pathway_suggestion_capital_ck" CHECK ((
            estimated_capital_min_in_cents IS NULL
            AND estimated_capital_max_in_cents IS NULL
            AND capital_basis_text IS NULL
          ) OR (
            estimated_capital_min_in_cents IS NOT NULL
            AND estimated_capital_max_in_cents IS NOT NULL
            AND capital_basis_text IS NOT NULL
            AND estimated_capital_min_in_cents >= 0
            AND estimated_capital_min_in_cents <= estimated_capital_max_in_cents
            AND char_length(capital_basis_text) BETWEEN 1 AND 400
          ));