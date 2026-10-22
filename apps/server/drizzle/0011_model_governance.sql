CREATE TABLE "decision_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"thresholds" jsonb,
	"note" text NOT NULL,
	"based_on_version" integer,
	"rollback_of_version" integer,
	"proposed_by" uuid,
	"proposed_at" timestamp with time zone NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"self_approved" boolean DEFAULT false NOT NULL,
	"activated_at" timestamp with time zone,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "engine_version" text;--> statement-breakpoint
ALTER TABLE "identity_checks" ADD COLUMN "decision_config_version" integer;--> statement-breakpoint
ALTER TABLE "identity_checks" ADD COLUMN "calibration_version" text;--> statement-breakpoint
ALTER TABLE "identity_checks" ADD COLUMN "model_version" text;--> statement-breakpoint
ALTER TABLE "decision_configs" ADD CONSTRAINT "decision_configs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_configs" ADD CONSTRAINT "decision_configs_proposed_by_staff_users_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_configs" ADD CONSTRAINT "decision_configs_decided_by_staff_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "decision_configs_version_uq" ON "decision_configs" USING btree ("org_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "decision_configs_active_uq" ON "decision_configs" USING btree ("org_id") WHERE "decision_configs"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "decision_configs_proposed_uq" ON "decision_configs" USING btree ("org_id") WHERE "decision_configs"."status" = 'proposed';--> statement-breakpoint
CREATE INDEX "events_org_flags_started_idx" ON "events" USING btree ("org_id","started_at") WHERE "events"."category" in ('integrity', 'uncertain', 'technical');--> statement-breakpoint
CREATE INDEX "exam_sessions_org_started_idx" ON "exam_sessions" USING btree ("org_id","started_at");--> statement-breakpoint
CREATE INDEX "identity_checks_at_idx" ON "identity_checks" USING btree ("at");