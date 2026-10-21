CREATE TABLE `watches` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`interval_minutes` integer NOT NULL,
	`keyword` text,
	`text_hash` text,
	`last_text` text,
	`next_check_at` integer NOT NULL,
	`last_checked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `watches_bot_id` ON `watches` (`bot_id`);