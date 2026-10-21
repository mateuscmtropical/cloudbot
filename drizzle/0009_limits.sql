CREATE TABLE `bot_limits` (
	`bot_id` text PRIMARY KEY NOT NULL,
	`chat_minutes` integer,
	`chat_usd` real,
	`chat_steps` integer,
	`routine_minutes` integer,
	`routine_usd` real,
	`routine_steps` integer,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade
);
