/**
 * Lookup seam between the files route and the documents domain.
 *
 * TODO(health-etv.12 / health-etv.5): implement against the documents table
 * once the DB layer (src/db) and documents schema land on main:
 *
 *   SELECT s3_key, content_type, original_filename FROM documents WHERE id = $1
 *
 * (etv.12's documents repo specs registerUpload/updateStatus/searchDocuments
 * but no by-id getter — this module is the home for that read.) Until then
 * every lookup returns null and GET /api/files/[documentId] 404s.
 */
export interface DocumentFileRef {
  s3Key: string;
  contentType: string | null;
  filename: string;
}

export async function findDocumentFile(
  documentId: string,
): Promise<DocumentFileRef | null> {
  void documentId;
  return null;
}
