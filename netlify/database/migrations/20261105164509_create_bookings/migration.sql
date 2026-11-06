CREATE TABLE "bookings" (
	"ref" text PRIMARY KEY,
	"name" text NOT NULL,
	"contact" text NOT NULL,
	"class_name" text NOT NULL,
	"section" text NOT NULL,
	"items" jsonb NOT NULL,
	"total" integer NOT NULL,
	"payment_method" text NOT NULL,
	"status" text DEFAULT 'UNPAID' NOT NULL,
	"slot_index" integer,
	"gaming_sessions" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
