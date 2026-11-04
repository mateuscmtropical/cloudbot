-- The search index of the chats. Triggers keep it in step with messages, also when a bot delete cascades.
-- Tool rows are not indexed, since the chat does not show them.
CREATE VIRTUAL TABLE `messages_fts` USING fts5(`body`, tokenize = 'unicode61 remove_diacritics 2');
--> statement-breakpoint
INSERT INTO `messages_fts` (`rowid`, `body`)
SELECT `sequence`, coalesce(json_extract(`content`, '$.text'), json_extract(`content`, '$.prompt'), json_extract(`content`, '$.name'))
FROM `messages`
WHERE `kind` IN ('text', 'choice', 'link', 'file') AND json_valid(`content`);
--> statement-breakpoint
CREATE TRIGGER `messages_fts_insert` AFTER INSERT ON `messages`
WHEN new.`kind` IN ('text', 'choice', 'link', 'file')
BEGIN
    INSERT INTO `messages_fts` (`rowid`, `body`)
    VALUES (new.`sequence`, coalesce(json_extract(new.`content`, '$.text'), json_extract(new.`content`, '$.prompt'), json_extract(new.`content`, '$.name')));
END;
--> statement-breakpoint
CREATE TRIGGER `messages_fts_update` AFTER UPDATE OF `content` ON `messages`
WHEN new.`kind` IN ('text', 'choice', 'link', 'file')
BEGIN
    DELETE FROM `messages_fts` WHERE `rowid` = old.`sequence`;
    INSERT INTO `messages_fts` (`rowid`, `body`)
    VALUES (new.`sequence`, coalesce(json_extract(new.`content`, '$.text'), json_extract(new.`content`, '$.prompt'), json_extract(new.`content`, '$.name')));
END;
--> statement-breakpoint
CREATE TRIGGER `messages_fts_delete` AFTER DELETE ON `messages`
BEGIN
    DELETE FROM `messages_fts` WHERE `rowid` = old.`sequence`;
END;
