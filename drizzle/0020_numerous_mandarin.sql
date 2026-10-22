CREATE TABLE `bot_skills` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`text` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bot_skills_bot_id_name` ON `bot_skills` (`bot_id`,`name`);