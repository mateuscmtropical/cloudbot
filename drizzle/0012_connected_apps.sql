CREATE TABLE `connected_apps` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`status` text NOT NULL,
	`tool_count` integer NOT NULL,
	`problem` text,
	`secret_name` text,
	`secret_bot_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connected_apps_name` ON `connected_apps` (`name`);