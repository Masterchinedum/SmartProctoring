CREATE TABLE "answers" (
	"session_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"value" jsonb,
	"client_seq" integer NOT NULL,
	"answered_at" timestamp with time zone NOT NULL,
	"saved_at" timestamp with time zone NOT NULL,
	CONSTRAINT "answers_session_id_question_id_pk" PRIMARY KEY("session_id","question_id")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"at" timestamp with time zone NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" text
);
--> statement-breakpoint
CREATE TABLE "candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"external_id" text,
	"id_photo_evidence_id" uuid,
	"id_photo_embedding" "bytea",
	"id_photo_quality" jsonb,
	"id_photo_approved_at" timestamp with time zone,
	"id_photo_approved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "check_frames" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"check_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"step" text NOT NULL,
	"action" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"analysis" jsonb NOT NULL,
	"embedding_enc" "bytea",
	"evidence_id" uuid,
	"face_crop_evidence_id" uuid,
	"client_yaw" double precision,
	"client_pitch" double precision
);
--> statement-breakpoint
CREATE TABLE "checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"client_instance_id" text NOT NULL,
	"device" jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"liveness" jsonb,
	"nonce" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"result" jsonb
);
--> statement-breakpoint
CREATE TABLE "device_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"check_id" uuid,
	"at" timestamp with time zone NOT NULL,
	"client_instance_id" text NOT NULL,
	"purpose" text NOT NULL,
	"camera_label" text DEFAULT '' NOT NULL,
	"camera_id_hash" text DEFAULT '' NOT NULL,
	"user_agent" text DEFAULT '' NOT NULL,
	"screen" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"video_width" integer,
	"video_height" integer
);
--> statement-breakpoint
CREATE TABLE "evaluation_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"report" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"type" text NOT NULL,
	"category" text NOT NULL,
	"severity" text NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"title" text NOT NULL,
	"observation" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"confidence" double precision,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"client_instance_id" text,
	"first_received_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"delivered_late" boolean DEFAULT false NOT NULL,
	"review_status" text DEFAULT 'unreviewed' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"session_id" uuid,
	"candidate_id" uuid,
	"event_id" uuid,
	"identity_check_id" uuid,
	"kind" text NOT NULL,
	"reason" text,
	"captured_at" timestamp with time zone NOT NULL,
	"storage_key" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"key_id" text NOT NULL,
	"content_type" text DEFAULT 'image/jpeg' NOT NULL,
	"client_instance_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purged_at" timestamp with time zone,
	"purge_reason" text
);
--> statement-breakpoint
CREATE TABLE "exam_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"exam_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"access_token_hash" text NOT NULL,
	"access_token_enc" "bytea",
	"status" text DEFAULT 'invited' NOT NULL,
	"end_reason" text,
	"policy" jsonb,
	"duration_ms" integer NOT NULL,
	"used_ms" integer DEFAULT 0 NOT NULL,
	"running_since" timestamp with time zone,
	"current_question_index" integer DEFAULT 0 NOT NULL,
	"consent_accepted_at" timestamp with time zone,
	"consent_notice_version" text,
	"consent_ip" text,
	"consent_user_agent" text,
	"active_instance_id" text,
	"verified_instance_id" text,
	"last_heartbeat_at" timestamp with time zone,
	"last_heartbeat_instance_id" text,
	"last_verified_heartbeat_at" timestamp with time zone,
	"connection" text DEFAULT 'never_connected' NOT NULL,
	"reporting_interrupted_since" timestamp with time zone,
	"reporting_event_id" uuid,
	"monitoring" jsonb,
	"identity_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_identity_decision" text,
	"last_identity_at" timestamp with time zone,
	"last_identity_similarity" double precision,
	"hold_reason" text,
	"hold_since" timestamp with time zone,
	"hold_message" text,
	"hold_can_reverify" boolean DEFAULT false NOT NULL,
	"hold_prev_status" text,
	"re_enroll_authorized" boolean DEFAULT false NOT NULL,
	"re_enroll_authorized_by" uuid,
	"check_attempts_reset_at" timestamp with time zone,
	"pause_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"legal_hold" boolean DEFAULT false NOT NULL,
	"evidence_purged_at" timestamp with time zone,
	"score" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"duration_sec" integer NOT NULL,
	"policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"sample_id" text,
	"check_id" uuid,
	"trigger" text NOT NULL,
	"decision" text NOT NULL,
	"similarity" double precision,
	"confidence" double precision NOT NULL,
	"quality" jsonb,
	"guidance" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"probe_evidence_id" uuid,
	"frame_evidence_id" uuid,
	"reference_id" uuid,
	"dhash" text,
	"client_instance_id" text,
	"context" jsonb DEFAULT '{"precededBy":[],"periodKind":null,"secondsSincePreviousMatch":null}'::jsonb NOT NULL,
	"event_id" uuid,
	"response" jsonb
);
--> statement-breakpoint
CREATE TABLE "identity_references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"embeddings_enc" "bytea",
	"embedding_count" integer NOT NULL,
	"quality" jsonb,
	"liveness" jsonb,
	"id_photo" jsonb,
	"image_evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"environment" jsonb,
	"check_id" uuid,
	"authorized_by" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"superseded_at" timestamp with time zone,
	"superseded_reason" text,
	"superseded_by" uuid,
	"purged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"event_id" uuid,
	"author_id" uuid NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pause_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"reason" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"decision_note" text
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exam_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"type" text NOT NULL,
	"prompt" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"correct" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"points" double precision DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_commands" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"target_instance_id" text,
	"command" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "session_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"observed" boolean NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"reason" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"staff_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "staff_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"password_hash" text NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"last_login_at" timestamp with time zone,
	"password_changed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_session_id_exam_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."exam_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_frames" ADD CONSTRAINT "check_frames_check_id_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."checks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checks" ADD CONSTRAINT "checks_session_id_exam_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."exam_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_records" ADD CONSTRAINT "device_records_session_id_exam_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."exam_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_session_id_exam_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."exam_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_sessions" ADD CONSTRAINT "exam_sessions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_sessions" ADD CONSTRAINT "exam_sessions_exam_id_exams_id_fk" FOREIGN KEY ("exam_id") REFERENCES "public"."exams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_sessions" ADD CONSTRAINT "exam_sessions_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exams" ADD CONSTRAINT "exams_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_checks" ADD CONSTRAINT "identity_checks_session_id_exam_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."exam_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_references" ADD CONSTRAINT "identity_references_session_id_exam_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."exam_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_session_id_exam_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."exam_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pause_requests" ADD CONSTRAINT "pause_requests_session_id_exam_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."exam_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_exam_id_exams_id_fk" FOREIGN KEY ("exam_id") REFERENCES "public"."exams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_commands" ADD CONSTRAINT "session_commands_session_id_exam_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."exam_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_periods" ADD CONSTRAINT "session_periods_session_id_exam_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."exam_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_sessions" ADD CONSTRAINT "staff_sessions_staff_user_id_staff_users_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_users" ADD CONSTRAINT "staff_users_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_org_at_idx" ON "audit_log" USING btree ("org_id","at");--> statement-breakpoint
CREATE INDEX "audit_log_target_idx" ON "audit_log" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "candidates_org_idx" ON "candidates" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "candidates_email_idx" ON "candidates" USING btree ("org_id","email");--> statement-breakpoint
CREATE INDEX "check_frames_check_idx" ON "check_frames" USING btree ("check_id","captured_at");--> statement-breakpoint
CREATE INDEX "checks_session_idx" ON "checks" USING btree ("session_id","issued_at");--> statement-breakpoint
CREATE INDEX "checks_open_idx" ON "checks" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "device_records_session_idx" ON "device_records" USING btree ("session_id","at");--> statement-breakpoint
CREATE INDEX "evaluation_reports_kind_idx" ON "evaluation_reports" USING btree ("kind","created_at");--> statement-breakpoint
CREATE INDEX "events_session_started_idx" ON "events" USING btree ("session_id","started_at");--> statement-breakpoint
CREATE INDEX "events_category_idx" ON "events" USING btree ("category");--> statement-breakpoint
CREATE INDEX "events_review_idx" ON "events" USING btree ("review_status");--> statement-breakpoint
CREATE INDEX "events_org_received_idx" ON "events" USING btree ("org_id","received_at");--> statement-breakpoint
CREATE INDEX "events_type_idx" ON "events" USING btree ("type");--> statement-breakpoint
CREATE INDEX "evidence_session_idx" ON "evidence" USING btree ("session_id","captured_at");--> statement-breakpoint
CREATE INDEX "evidence_event_idx" ON "evidence" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "evidence_candidate_idx" ON "evidence" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "evidence_purge_idx" ON "evidence" USING btree ("purged_at");--> statement-breakpoint
CREATE UNIQUE INDEX "exam_sessions_token_uq" ON "exam_sessions" USING btree ("access_token_hash");--> statement-breakpoint
CREATE INDEX "exam_sessions_org_status_idx" ON "exam_sessions" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "exam_sessions_exam_idx" ON "exam_sessions" USING btree ("exam_id");--> statement-breakpoint
CREATE INDEX "exam_sessions_candidate_idx" ON "exam_sessions" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "exam_sessions_heartbeat_idx" ON "exam_sessions" USING btree ("connection","last_heartbeat_at");--> statement-breakpoint
CREATE INDEX "exams_org_idx" ON "exams" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_checks_sample_uq" ON "identity_checks" USING btree ("session_id","sample_id");--> statement-breakpoint
CREATE INDEX "identity_checks_session_idx" ON "identity_checks" USING btree ("session_id","at");--> statement-breakpoint
CREATE INDEX "identity_checks_event_idx" ON "identity_checks" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "identity_references_session_idx" ON "identity_references" USING btree ("session_id","version");--> statement-breakpoint
CREATE INDEX "notes_session_idx" ON "notes" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "notes_event_idx" ON "notes" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "pause_requests_session_idx" ON "pause_requests" USING btree ("session_id","requested_at");--> statement-breakpoint
CREATE INDEX "questions_exam_idx" ON "questions" USING btree ("exam_id","position");--> statement-breakpoint
CREATE INDEX "session_commands_pending_idx" ON "session_commands" USING btree ("session_id","delivered_at");--> statement-breakpoint
CREATE INDEX "session_periods_session_idx" ON "session_periods" USING btree ("session_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_sessions_token_uq" ON "staff_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "staff_sessions_user_idx" ON "staff_sessions" USING btree ("staff_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_users_email_uq" ON "staff_users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "staff_users_org_idx" ON "staff_users" USING btree ("org_id");