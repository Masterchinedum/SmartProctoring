CREATE TABLE "staff_login_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"staff_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"ip" text
);
--> statement-breakpoint
CREATE TABLE "staff_recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "staff_users" ADD COLUMN "totp_secret_enc" "bytea";--> statement-breakpoint
ALTER TABLE "staff_users" ADD COLUMN "totp_last_step" integer;--> statement-breakpoint
ALTER TABLE "staff_users" ADD COLUMN "mfa_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "staff_users" ADD COLUMN "totp_pending_enc" "bytea";--> statement-breakpoint
ALTER TABLE "staff_users" ADD COLUMN "totp_pending_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "staff_login_challenges" ADD CONSTRAINT "staff_login_challenges_staff_user_id_staff_users_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_recovery_codes" ADD CONSTRAINT "staff_recovery_codes_staff_user_id_staff_users_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_login_challenges_token_uq" ON "staff_login_challenges" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "staff_login_challenges_user_idx" ON "staff_login_challenges" USING btree ("staff_user_id");--> statement-breakpoint
CREATE INDEX "staff_recovery_codes_user_idx" ON "staff_recovery_codes" USING btree ("staff_user_id");