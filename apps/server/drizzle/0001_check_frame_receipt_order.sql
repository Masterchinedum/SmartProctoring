DROP INDEX "check_frames_check_idx";--> statement-breakpoint
ALTER TABLE "check_frames" ADD COLUMN "seq" bigserial NOT NULL;--> statement-breakpoint
CREATE INDEX "check_frames_check_idx" ON "check_frames" USING btree ("check_id","seq");