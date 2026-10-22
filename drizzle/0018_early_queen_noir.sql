CREATE TABLE `email_accounts` (
	`bot_id` text PRIMARY KEY NOT NULL,
	`address` text NOT NULL,
	`imap_host` text NOT NULL,
	`imap_port` integer NOT NULL,
	`smtp_host` text NOT NULL,
	`smtp_port` integer NOT NULL,
	`smtp_secure` integer NOT NULL,
	`username` text NOT NULL,
	`uid_validity` text,
	`last_uid` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `email_deliveries` (
	`bot_id` text NOT NULL,
	`uid_validity` text NOT NULL,
	`uid` integer NOT NULL,
	`claimed_at` integer NOT NULL,
	`handled_at` integer,
	PRIMARY KEY(`bot_id`, `uid_validity`, `uid`),
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `messages` ADD `email_delivery_id` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_email_delivery_id` ON `messages` (`email_delivery_id`);
