CREATE TABLE `bot_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`blocked_tools` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `bot_rules_bot_id` ON `bot_rules` (`bot_id`);