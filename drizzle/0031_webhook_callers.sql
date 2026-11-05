CREATE TABLE `webhook_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`webhook_id` text NOT NULL,
	`time` integer NOT NULL,
	`provider` text NOT NULL,
	`event` text,
	`address` text,
	`user_agent` text,
	FOREIGN KEY (`webhook_id`) REFERENCES `webhooks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `webhook_calls_webhook_id_time` ON `webhook_calls` (`webhook_id`,`time`);--> statement-breakpoint
CREATE INDEX `webhook_calls_time` ON `webhook_calls` (`time`);--> statement-breakpoint
ALTER TABLE `webhooks` ADD `rules` text DEFAULT '{}' NOT NULL;