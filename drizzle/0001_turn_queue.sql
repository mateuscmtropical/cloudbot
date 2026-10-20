CREATE TABLE `turn_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`position` integer NOT NULL,
	`message_id` text,
	`text` text NOT NULL,
	`uploads` text NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `turn_queue_bot_id` ON `turn_queue` (`bot_id`);--> statement-breakpoint
CREATE TABLE `turn_waits` (
	`bot_id` text PRIMARY KEY NOT NULL,
	`resume_at` integer NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade
);
