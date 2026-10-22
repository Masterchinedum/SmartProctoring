ALTER TABLE "exam_sessions" ADD COLUMN "window_starts_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "exam_sessions" ADD COLUMN "window_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "exam_sessions" ADD COLUMN "reconnect_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "exam_sessions_offline_idx" ON "exam_sessions" USING btree ("status") WHERE "exam_sessions"."connection" = 'offline';