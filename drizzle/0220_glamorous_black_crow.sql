-- todo §7: Google/GitHub first sign-ins are recorded as Terms acceptances at creation
-- (`user.create.after`), beside a Terms sentence on every page with those buttons. Generated.
ALTER TYPE "public"."user_terms_acceptance_surface" ADD VALUE 'oauth_sign_up';