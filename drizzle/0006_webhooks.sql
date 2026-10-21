CREATE TABLE `webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhooks_token_hash_unique` ON `webhooks` (`token_hash`);--> statement-breakpoint
CREATE INDEX `webhooks_bot_id` ON `webhooks` (`bot_id`);