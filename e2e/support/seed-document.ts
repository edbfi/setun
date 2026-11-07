import { eq } from "drizzle-orm";
import { recordGeneratedDocument } from "../../src/lib/server/db/queries/documents";
import { student } from "../../src/lib/server/db/schema";
import { DOCUMENT_MEDIA_TYPES } from "../../src/lib/server/documents/formats";
import { FileStore } from "../../src/lib/server/storage/files";
import { openE2eDatabase } from "./database";

/**
 * Give one student a generated csv document, so the download route has a real
 * row and real bytes to serve.
 *
 * Written through the same file store and query module `createDocument` uses,
 * so what is on disk is what a model's call leaves behind — only the turn is
 * skipped, as `seed-image.ts` skips the provider call.
 *
 * Usage: `SETUN_E2E_STUDENT_LABEL=<label> bun run e2e/support/seed-document.ts`
 */
const databasePath = process.env.SETUN_DATABASE_PATH;
const storagePath = process.env.SETUN_STORAGE_PATH;
const label = process.env.SETUN_E2E_STUDENT_LABEL;

if (!databasePath || !storagePath || !label) {
  console.error(
    "SETUN_DATABASE_PATH, SETUN_STORAGE_PATH and SETUN_E2E_STUDENT_LABEL are required",
  );
  process.exit(1);
}

const db = await openE2eDatabase(databasePath);
const owner = db.select().from(student).where(eq(student.label, label)).get();

if (!owner) {
  console.error(`no student labelled '${label}'`);
  process.exit(1);
}

const { storagePath: stored } = await new FileStore(storagePath).write({
  category: "documents",
  ownerId: owner.id,
  bytes: new TextEncoder().encode("\uFEFFBlad,Farve\r\nEg,Grøn\r\n"),
  extension: "csv",
});

const document = recordGeneratedDocument(db, {
  studentId: owner.id,
  title: "Blade og farver",
  format: "csv",
  mediaType: DOCUMENT_MEDIA_TYPES.csv,
  storagePath: stored,
});

console.log(JSON.stringify({ id: document.id, title: document.title }));
