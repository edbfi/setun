CREATE TABLE `context_summary` (
	`id` text PRIMARY KEY NOT NULL,
	`conversationId` text NOT NULL,
	`throughMessageId` text NOT NULL,
	`text` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`conversationId`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`throughMessageId`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `context_summary_conversation_idx` ON `context_summary` (`conversationId`);--> statement-breakpoint
ALTER TABLE `model_alias` ADD `contextWindowTokens` integer;
