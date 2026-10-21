CREATE TABLE "exam_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exam_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"instructions" text NOT NULL,
	"duration_sec" integer NOT NULL,
	"policy" jsonb NOT NULL,
	"questions" jsonb NOT NULL,
	"content_hash" text,
	"changes" jsonb NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "exam_sessions" ADD COLUMN "exam_version_id" uuid;--> statement-breakpoint
ALTER TABLE "exams" ADD COLUMN "current_version_id" uuid;--> statement-breakpoint
ALTER TABLE "exam_versions" ADD CONSTRAINT "exam_versions_exam_id_exams_id_fk" FOREIGN KEY ("exam_id") REFERENCES "public"."exams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "exam_versions_exam_number_uq" ON "exam_versions" USING btree ("exam_id","number");--> statement-breakpoint
ALTER TABLE "exam_sessions" ADD CONSTRAINT "exam_sessions_exam_version_id_exam_versions_id_fk" FOREIGN KEY ("exam_version_id") REFERENCES "public"."exam_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exam_sessions_exam_version_idx" ON "exam_sessions" USING btree ("exam_version_id");--> statement-breakpoint
-- Backfill: every exam that candidates can see (published / archived) or that an attempt already started gets version 1,
-- a snapshot of its current questions; attempts that already started are pinned to it (they saw these questions).
INSERT INTO "exam_versions" ("exam_id", "org_id", "number", "title", "description", "instructions", "duration_sec", "policy", "questions", "content_hash", "changes", "reason", "created_by", "created_at")
SELECT e."id", e."org_id", 1, e."title", e."description", e."instructions", e."duration_sec", e."policy",
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id', q."id", 'type', q."type", 'prompt', q."prompt", 'options', q."options", 'correct', q."correct", 'points', q."points") ORDER BY q."position") FROM "questions" q WHERE q."exam_id" = e."id"), '[]'::jsonb),
  NULL, '{"added":[],"removed":[],"changed":[],"exam":[]}'::jsonb, 'migrated', NULL, now()
FROM "exams" e
WHERE e."status" <> 'draft' OR EXISTS (SELECT 1 FROM "exam_sessions" s WHERE s."exam_id" = e."id" AND s."started_at" IS NOT NULL);
--> statement-breakpoint
UPDATE "exams" e SET "current_version_id" = v."id" FROM "exam_versions" v WHERE v."exam_id" = e."id" AND v."number" = 1;
--> statement-breakpoint
UPDATE "exam_sessions" s SET "exam_version_id" = v."id" FROM "exam_versions" v WHERE v."exam_id" = s."exam_id" AND v."number" = 1 AND s."started_at" IS NOT NULL;
