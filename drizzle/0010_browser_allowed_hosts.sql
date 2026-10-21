CREATE TABLE `browser_allowed_hosts` (
	`id` text PRIMARY KEY NOT NULL,
	`host` text NOT NULL,
	`port` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `browser_allowed_hosts_host_port` ON `browser_allowed_hosts` (`host`,`port`);