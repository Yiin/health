/**
 * Lookup seam between the files route and the documents domain: the minimal
 * read needed to stream a document's original bytes.
 */

import { getDb } from "@/db";
import { getDocument } from "@/db/repos/documents";

export interface DocumentFileRef {
  s3Key: string;
  contentType: string | null;
  filename: string;
}

export async function findDocumentFile(
  documentId: string,
): Promise<DocumentFileRef | null> {
  const document = await getDocument(getDb(), documentId);
  if (!document) return null;
  return {
    s3Key: document.s3Key,
    contentType: document.contentType,
    filename: document.originalFilename,
  };
}
