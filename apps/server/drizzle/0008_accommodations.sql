CREATE TABLE "accommodations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"exam_id" uuid,
	"kind" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"basis" text NOT NULL,
	"note_enc" "bytea",
	"valid_until" timestamp with time zone,
	"granted_by" uuid,
	"granted_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoke_reason" text
);
--> statement-breakpoint
ALTER TABLE "checks" ADD COLUMN "mode" text DEFAULT 'face' NOT NULL;--> statement-breakpoint
ALTER TABLE "exam_sessions" ADD COLUMN "accommodations" jsonb;--> statement-breakpoint
ALTER TABLE "accommodations" ADD CONSTRAINT "accommodations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accommodations" ADD CONSTRAINT "accommodations_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accommodations" ADD CONSTRAINT "accommodations_exam_id_exams_id_fk" FOREIGN KEY ("exam_id") REFERENCES "public"."exams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accommodations_candidate_idx" ON "accommodations" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "accommodations_org_idx" ON "accommodations" USING btree ("org_id");