CREATE TABLE `app_triggers` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`name` text NOT NULL,
	`source` text NOT NULL,
	`target` text NOT NULL,
	`prompt` text NOT NULL,
	`interval_minutes` integer NOT NULL,
	`seen` text,
	`next_check_at` integer NOT NULL,
	`last_checked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `app_triggers_bot_id` ON `app_triggers` (`bot_id`);