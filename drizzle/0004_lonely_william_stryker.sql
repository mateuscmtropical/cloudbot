CREATE TABLE `bot_models` (
	`bot_id` text PRIMARY KEY NOT NULL,
	`chat_model` text,
	`routines_model` text,
	`review_model` text,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `turn_queue` ADD `source` text DEFAULT 'chat' NOT NULL;