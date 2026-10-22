CREATE TABLE "org_usage" (
	"org_id" uuid NOT NULL,
	"month" text NOT NULL,
	"sessions_created" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_usage_org_id_month_pk" PRIMARY KEY("org_id","month")
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "kind" text DEFAULT 'production' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "quotas" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "sandbox_purge_days" integer;--> statement-breakpoint
ALTER TABLE "org_usage" ADD CONSTRAINT "org_usage_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_kind_check" CHECK ("organizations"."kind" in ('production', 'sandbox'));