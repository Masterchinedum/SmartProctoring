CREATE TABLE "identity_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"oidc_issuer" text,
	"oidc_client_id" text,
	"oidc_client_secret_enc" "bytea",
	"oidc_scopes" text DEFAULT 'openid email profile' NOT NULL,
	"oidc_require_verified_email" boolean DEFAULT true NOT NULL,
	"saml_entity_id" text,
	"saml_sso_url" text,
	"saml_certificates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"claim_mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"jit_enabled" boolean DEFAULT false NOT NULL,
	"jit_default_role" text DEFAULT 'reviewer' NOT NULL,
	"role_mappings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scim_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid
);
--> statement-breakpoint
CREATE TABLE "sso_domains" (
	"domain" text PRIMARY KEY NOT NULL,
	"provider_id" uuid NOT NULL,
	"org_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sso_login_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"browser_hash" text NOT NULL,
	"state_hash" text,
	"nonce" text,
	"code_verifier" text,
	"saml_request_id" text,
	"identity" jsonb,
	"return_to" text DEFAULT '/admin' NOT NULL,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sso_saml_assertions" (
	"provider_id" uuid NOT NULL,
	"assertion_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sso_saml_assertions_provider_id_assertion_id_pk" PRIMARY KEY("provider_id","assertion_id")
);
--> statement-breakpoint
CREATE TABLE "staff_sso_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_user_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "staff_sessions" ADD COLUMN "auth_method" text DEFAULT 'password' NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_sessions" ADD COLUMN "sso_provider_id" uuid;--> statement-breakpoint
ALTER TABLE "staff_users" ADD COLUMN "provisioned_via" text;--> statement-breakpoint
ALTER TABLE "staff_users" ADD COLUMN "scim_external_id" text;--> statement-breakpoint
ALTER TABLE "staff_users" ADD COLUMN "scim_deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "identity_providers" ADD CONSTRAINT "identity_providers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_tokens" ADD CONSTRAINT "scim_tokens_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_domains" ADD CONSTRAINT "sso_domains_provider_id_identity_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."identity_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_login_attempts" ADD CONSTRAINT "sso_login_attempts_provider_id_identity_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."identity_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_saml_assertions" ADD CONSTRAINT "sso_saml_assertions_provider_id_identity_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."identity_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_sso_identities" ADD CONSTRAINT "staff_sso_identities_staff_user_id_staff_users_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_sso_identities" ADD CONSTRAINT "staff_sso_identities_provider_id_identity_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."identity_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "identity_providers_org_idx" ON "identity_providers" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_tokens_hash_uq" ON "scim_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_tokens_active_org_uq" ON "scim_tokens" USING btree ("org_id") WHERE "scim_tokens"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "sso_domains_provider_idx" ON "sso_domains" USING btree ("provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sso_login_attempts_state_uq" ON "sso_login_attempts" USING btree ("state_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "sso_login_attempts_saml_request_uq" ON "sso_login_attempts" USING btree ("saml_request_id");--> statement-breakpoint
CREATE INDEX "sso_login_attempts_expires_idx" ON "sso_login_attempts" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sso_saml_assertions_expires_idx" ON "sso_saml_assertions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_sso_identities_subject_uq" ON "staff_sso_identities" USING btree ("provider_id","subject");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_sso_identities_user_uq" ON "staff_sso_identities" USING btree ("staff_user_id","provider_id");