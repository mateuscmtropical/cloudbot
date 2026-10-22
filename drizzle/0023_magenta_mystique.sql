CREATE TABLE `whatsapp_connections` (
	`phone_number_id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `whatsapp_connections_bot_id` ON `whatsapp_connections` (`bot_id`);--> statement-breakpoint
CREATE TABLE `whatsapp_messages` (
	`message_id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`received_at` integer NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `whatsapp_messages_received_at` ON `whatsapp_messages` (`received_at`);