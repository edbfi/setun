CREATE TABLE `generated_document` (
	`id` text PRIMARY KEY NOT NULL,
	`studentId` text NOT NULL,
	`conversationId` text,
	`messageId` text,
	`title` text NOT NULL,
	`format` text NOT NULL,
	`mediaType` text NOT NULL,
	`storagePath` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`studentId`) REFERENCES `student`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversationId`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`messageId`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `generated_document_student_idx` ON `generated_document` (`studentId`,`createdAt`);--> statement-breakpoint
ALTER TABLE `classroom` ADD `documentsEnabled` integer DEFAULT true NOT NULL;
