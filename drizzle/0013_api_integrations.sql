CREATE TABLE `integration_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`integration_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`exit_code` integer,
	`timed_out` integer NOT NULL,
	`output` text NOT NULL,
	FOREIGN KEY (`integration_id`) REFERENCES `integrations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `integrations` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`name` text NOT NULL,
	`entry_path` text NOT NULL,
	`command` text NOT NULL,
	`secret_name` text,
	`entry_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integrations_bot_name` ON `integrations` (`bot_id`,`name`);