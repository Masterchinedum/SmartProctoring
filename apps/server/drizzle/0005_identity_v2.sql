CREATE TABLE "identity_sample_frames" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"sample_id" text NOT NULL,
	"burst_id" text NOT NULL,
	"burst_index" integer NOT NULL,
	"burst_size" integer NOT NULL,
	"trigger" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"analysis" jsonb NOT NULL,
	"similarity" double precision,
	"decision" text NOT NULL,
	"llr" double precision,
	"embedding_enc" "bytea",
	"probe_evidence_id" uuid,
	"frame_evidence_id" uuid,
	"identity_check_id" uuid,
	"client_instance_id" text,
	"response" jsonb
);
--> statement-breakpoint
ALTER TABLE "identity_references" ADD COLUMN "baseline" jsonb;--> statement-breakpoint
ALTER TABLE "identity_sample_frames" ADD CONSTRAINT "identity_sample_frames_session_id_exam_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."exam_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "identity_sample_frames_sample_uq" ON "identity_sample_frames" USING btree ("session_id","sample_id");--> statement-breakpoint
CREATE INDEX "identity_sample_frames_burst_idx" ON "identity_sample_frames" USING btree ("session_id","burst_id");