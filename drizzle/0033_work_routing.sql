ALTER TABLE `bot_models` ADD `search_model` text;--> statement-breakpoint
ALTER TABLE `bot_models` ADD `checkins_model` text;--> statement-breakpoint
ALTER TABLE `bot_models` ADD `webhooks_model` text;--> statement-breakpoint
ALTER TABLE `bot_models` ADD `search_effort` text;--> statement-breakpoint
ALTER TABLE `bot_models` ADD `checkins_effort` text;--> statement-breakpoint
ALTER TABLE `bot_models` ADD `webhooks_effort` text;--> statement-breakpoint
ALTER TABLE `routines` ADD `provider` text;--> statement-breakpoint
ALTER TABLE `routines` ADD `model` text;--> statement-breakpoint
ALTER TABLE `routines` ADD `effort` text;--> statement-breakpoint
ALTER TABLE `turn_queue` ADD `routine_id` text;