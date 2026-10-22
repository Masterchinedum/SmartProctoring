CREATE TABLE "event_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"org_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"reviewer_id" uuid,
	"status" text NOT NULL,
	"resolution" text,
	"note" text,
	"previous_status" text NOT NULL,
	"previous_resolution" text,
	"previous_reviewer_id" uuid,
	"overrides" boolean DEFAULT false NOT NULL,
	"bulk" boolean DEFAULT false NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_reviews" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"assignee_id" uuid,
	"assigned_at" timestamp with time zone,
	"assigned_by" uuid,
	"escalated_at" timestamp with time zone,
	"escalated_by" uuid,
	"escalation_note" text,
	"outcome" text,
	"outcome_note" text,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "resolution" text;--> statement-breakpoint
ALTER TABLE "event_reviews" ADD CONSTRAINT "event_reviews_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_reviews" ADD CONSTRAINT "event_reviews_session_id_exam_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."exam_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_reviews" ADD CONSTRAINT "event_reviews_reviewer_id_staff_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_reviews" ADD CONSTRAINT "session_reviews_session_id_exam_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."exam_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_reviews" ADD CONSTRAINT "session_reviews_assignee_id_staff_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_reviews_event_idx" ON "event_reviews" USING btree ("event_id","at");--> statement-breakpoint
CREATE INDEX "event_reviews_org_at_idx" ON "event_reviews" USING btree ("org_id","at");--> statement-breakpoint
CREATE INDEX "event_reviews_session_idx" ON "event_reviews" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "session_reviews_org_state_idx" ON "session_reviews" USING btree ("org_id","state");--> statement-breakpoint
CREATE INDEX "session_reviews_assignee_idx" ON "session_reviews" USING btree ("assignee_id");--> statement-breakpoint
CREATE INDEX "events_undecided_flags_idx" ON "events" USING btree ("org_id","session_id","first_received_at") WHERE "events"."review_status" = 'unreviewed' and "events"."category" in ('integrity', 'uncertain', 'technical');--> statement-breakpoint
-- Approved accommodations and staff identity verification are policy exceptions, not session changes.
UPDATE "events" SET "category" = 'exception' WHERE "type" IN ('accommodations_applied', 'identity_verified_by_staff');--> statement-breakpoint
-- Existing decisions start the review history (one decision each, by the recorded reviewer when still known).
INSERT INTO "event_reviews" ("org_id", "event_id", "session_id", "reviewer_id", "status", "resolution", "note", "previous_status", "overrides", "bulk", "at")
SELECT e."org_id", e."id", e."session_id", su."id", e."review_status", NULL, e."review_note", 'unreviewed', false, false, COALESCE(e."reviewed_at", e."received_at")
FROM "events" e LEFT JOIN "staff_users" su ON su."id" = e."reviewed_by"
WHERE e."review_status" <> 'unreviewed';
