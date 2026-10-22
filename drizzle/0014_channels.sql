CREATE TABLE `channel_members` (
	`channel_id` text NOT NULL,
	`bot_id` text NOT NULL,
	`is_manager` integer DEFAULT false NOT NULL,
	`joined_at` integer NOT NULL,
	PRIMARY KEY(`channel_id`, `bot_id`),
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `channel_members_bot_id` ON `channel_members` (`bot_id`);--> statement-breakpoint
CREATE TABLE `channel_messages` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`channel_id` text NOT NULL,
	`author_bot_id` text,
	`author_name` text NOT NULL,
	`author_color` text NOT NULL,
	`author_shape` text NOT NULL,
	`role` text NOT NULL,
	`kind` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_messages_id_unique` ON `channel_messages` (`id`);--> statement-breakpoint
CREATE INDEX `channel_messages_channel_id` ON `channel_messages` (`channel_id`);--> statement-breakpoint
CREATE TABLE `channels` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channels_name_lower` ON `channels` (lower("name"));