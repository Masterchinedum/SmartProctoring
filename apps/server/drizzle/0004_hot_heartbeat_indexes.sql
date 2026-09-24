DROP INDEX "exam_sessions_heartbeat_idx";--> statement-breakpoint
CREATE INDEX "exam_sessions_online_idx" ON "exam_sessions" USING btree ("status") WHERE "exam_sessions"."connection" = 'online';--> statement-breakpoint
CREATE INDEX "exam_sessions_running_idx" ON "exam_sessions" USING btree ("status") WHERE "exam_sessions"."running_since" is not null;--> statement-breakpoint
-- Leave room on each page so heartbeat updates (which touch no indexed column) can be HOT updates.
ALTER TABLE "exam_sessions" SET (fillfactor = 80);