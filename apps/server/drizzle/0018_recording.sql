CREATE TABLE "recording_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"evidence_id" uuid NOT NULL,
	"stream" text NOT NULL,
	"seq" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"client_instance_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recording_segments_stream_check" CHECK ("recording_segments"."stream" in ('camera', 'screen'))
);
--> statement-breakpoint
ALTER TABLE "recording_segments" ADD CONSTRAINT "recording_segments_session_id_exam_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."exam_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_segments" ADD CONSTRAINT "recording_segments_evidence_id_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recording_segments_upload_uq" ON "recording_segments" USING btree ("session_id","stream","client_instance_id","seq");--> statement-breakpoint
CREATE INDEX "recording_segments_session_idx" ON "recording_segments" USING btree ("session_id","started_at");--> statement-breakpoint
CREATE INDEX "recording_segments_evidence_idx" ON "recording_segments" USING btree ("evidence_id");