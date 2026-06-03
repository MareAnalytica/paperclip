ALTER TABLE "cost_events" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN "qty" numeric(20, 6);--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN "cache_write_tokens" bigint;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN "unit_price_micros" bigint;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN "cost_micros" bigint;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN "currency" char(3);--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN "pricebook_version" text;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN "request_id" text;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN "meta" jsonb;--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cost_events_provider_model_occurred_idx" ON "cost_events" USING btree ("provider","model","occurred_at");--> statement-breakpoint
CREATE INDEX "cost_events_agent_occurred_idx" ON "cost_events" USING btree ("agent_id","occurred_at");--> statement-breakpoint
CREATE INDEX "cost_events_project_occurred_idx" ON "cost_events" USING btree ("project_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cost_events_idempotency_key_uq" ON "cost_events" USING btree ("idempotency_key");