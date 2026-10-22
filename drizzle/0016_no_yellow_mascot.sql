-- Yellow reads as brown, so it left the palette. Bots and channel posts that had it move to orange.
UPDATE `bots` SET `mascot_color` = 'orange' WHERE `mascot_color` = 'yellow';--> statement-breakpoint
UPDATE `channel_messages` SET `author_color` = 'orange' WHERE `author_color` = 'yellow';
