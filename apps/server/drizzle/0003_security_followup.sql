CREATE TABLE "login_throttle" (
	"key" text PRIMARY KEY NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_failure_at" timestamp with time zone NOT NULL,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "exam_sessions" ADD COLUMN "instance_usage" jsonb;--> statement-breakpoint
CREATE INDEX "login_throttle_last_failure_idx" ON "login_throttle" USING btree ("last_failure_at");