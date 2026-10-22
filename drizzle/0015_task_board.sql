CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`channel_id` text,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`blocked_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tasks_bot_id` ON `tasks` (`bot_id`);