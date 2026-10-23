CREATE TABLE `bot_provider_models` (
	`bot_id` text NOT NULL,
	`provider` text NOT NULL,
	`model` text,
	`effort` text,
	PRIMARY KEY(`bot_id`, `provider`),
	FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON UPDATE no action ON DELETE cascade
);
