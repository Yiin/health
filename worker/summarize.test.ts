// Tests of the summarizing stage (worker/summarize.ts), driving the stage
// runner directly against a real database with a mocked Kimi:
// - every processed document gets an ai_summary, findable via the documents
//   repo full-text searchDocuments;
// - a lab_report produces exactly one ai_insights row whose source_refs point
//   at the real document + biomarker_result rows, even across stage retries;
// - non-lab documents (incl. wearable/activity) get no insight in v1;
// - model-output validation: one retry with the error appended, then throw.

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { searchDocuments } from "../src/db/repos/documents";
import { setupTestDb, TEST_DATABASE_URL } from "../src/db/test-utils";
import type { ChatStructuredParams } from "../src/lib/kimi/client";

import type { StageContext } from "./ingestion";
import {
  createSummarizeStage,
  INSIGHT_PROMPT_V1,
  SUMMARY_PROMPT_V1,
} from "./summarize";

const getDb = setupTestDb();

let sql: postgres.Sql;
beforeAll(() => {
  sql = postgres(TEST_DATABASE_URL, { max: 2 });
});
afterAll(async () => {
  await sql.end();
});

const SUMMARY = "Quarterly blood panel from Quokka Labs; hemoglobin in range.";
const INSIGHT = {
  title: "Hemoglobin up 10% since January, now in range",
  body: "Hemoglobin rose from 12.8 to 14.2 g/dL and is back inside the reference range.",
};

/** Replies to summary/insight calls by schema name; records every call. */
function fakeChat(
  calls: ChatStructuredParams[],
  overrides: {
    summaryReplies?: string[];
    insightReplies?: string[];
  } = {},
) {
  const summaryReplies = [...(overrides.summaryReplies ?? [])];
  const insightReplies = [...(overrides.insightReplies ?? [])];
  return async (params: ChatStructuredParams): Promise<string> => {
    calls.push(params);
    if (params.schema.name === "document_summary") {
      return summaryReplies.shift() ?? JSON.stringify({ summary: SUMMARY });
    }
    if (params.schema.name === "post_ingestion_insight") {
      return insightReplies.shift() ?? JSON.stringify(INSIGHT);
    }
    throw new Error(`unexpected schema ${params.schema.name}`);
  };
}

function ctxOf(documentId: string, filename = "report.pdf"): StageContext {
  return {
    documentId,
    sha256: "ab".repeat(32),
    originalFilename: filename,
    attempt: 1,
  };
}

interface InsertDocumentOptions {
  documentType?: string;
  extractedText?: string | null;
  provider?: string | null;
  documentDate?: string | null;
  filename?: string;
}

async function insertDocument(
  options: InsertDocumentOptions = {},
): Promise<string> {
  // NB: null is a meaningful value for the nullable columns (a document
  // without a text layer), so defaults apply only when the key is absent —
  // `??` would swallow the explicit nulls the tests pass.
  const value = <T>(key: keyof InsertDocumentOptions, fallback: T): T | null =>
    key in options ? (options[key] as T | null) : fallback;
  const rows = await sql<{ id: string }[]>`
    insert into documents (
      sha256, original_filename, s3_key, status,
      document_type, extracted_text, provider, document_date
    )
    values (
      ${crypto.randomUUID()},
      ${options.filename ?? "report.pdf"},
      'originals//ab/fixture',
      'normalizing',
      ${options.documentType ?? "lab_report"},
      ${value("extractedText", "Hemoglobin 14.2 g/dL (12.0-16.0)")},
      ${value("provider", "Quokka Labs")},
      ${value("documentDate", "2026-03-14")}
    )
    returning id
  `;
  return rows[0].id;
}

async function insertBiomarker(slug: string, name: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into biomarkers (slug, name, category, canonical_unit)
    values (${slug}, ${name}, 'blood', 'g/dL')
    returning id
  `;
  return rows[0].id;
}

interface InsertResultOptions {
  measuredOn: string;
  value: number;
  documentId?: string | null;
  flag?: string | null;
}

async function insertResult(
  biomarkerId: string,
  options: InsertResultOptions,
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into biomarker_results (
      biomarker_id, measured_on, value, unit, value_canonical,
      ref_low, ref_high, flag, document_id
    )
    values (
      ${biomarkerId}, ${options.measuredOn}, ${options.value}, 'g/dL',
      ${options.value}, 12.0, 16.0, ${options.flag ?? null},
      ${options.documentId ?? null}
    )
    returning id
  `;
  return rows[0].id;
}

async function insightRows(documentId: string) {
  return sql<
    {
      id: string;
      kind: string;
      title: string | null;
      body_md: string;
      model: string | null;
      prompt_version: string | null;
      source_refs: { kind: string; id: string; note?: string }[];
    }[]
  >`
    select id, kind, title, body_md, model, prompt_version, source_refs
    from ai_insights
    where source_refs @> ${sql.json([{ kind: "document", id: documentId }])}
  `;
}

describe("summarizing stage", () => {
  it("summarizes a lab report and files exactly one insight with real refs", async () => {
    const documentId = await insertDocument();
    const hemoglobin = await insertBiomarker("hemoglobin", "Hemoglobin");
    // History from an earlier report, then this document's new result.
    await insertResult(hemoglobin, { measuredOn: "2026-01-10", value: 12.8 });
    const newResultId = await insertResult(hemoglobin, {
      measuredOn: "2026-03-14",
      value: 14.2,
      documentId,
      flag: "normal",
    });

    const calls: ChatStructuredParams[] = [];
    const payload = (await createSummarizeStage({
      sql,
      chatStructured: fakeChat(calls),
      model: "kimi-test",
    })(ctxOf(documentId))) as Record<string, unknown>;

    // Two Kimi calls: summary, then insight.
    expect(calls.map((c) => c.schema.name)).toEqual([
      "document_summary",
      "post_ingestion_insight",
    ]);
    expect(payload.promptVersion).toBe(SUMMARY_PROMPT_V1);
    expect(payload.summary).toBe(SUMMARY);

    // The insight prompt carries the new result AND the history trend.
    const insightPrompt = calls[1].messages.at(-1)?.content as string;
    expect(insightPrompt).toContain("Hemoglobin (hemoglobin): 14.2 g/dL");
    expect(insightPrompt).toContain("2026-01-10=12.8");
    expect(insightPrompt).toContain("2026-03-14=14.2");

    // ai_summary persisted + searchable through the documents repo FTS.
    const docs = await sql<
      { ai_summary: string | null }[]
    >`select ai_summary from documents where id = ${documentId}`;
    expect(docs[0].ai_summary).toBe(SUMMARY);
    const hits = await searchDocuments(getDb(), "quokka");
    expect(hits.map((hit) => hit.id)).toContain(documentId);

    // Exactly one insight, pointing at the real document + result rows.
    const insights = await insightRows(documentId);
    expect(insights).toHaveLength(1);
    const insight = insights[0];
    expect(insight.kind).toBe("post_ingestion");
    expect(insight.title).toBe(INSIGHT.title);
    expect(insight.body_md).toBe(INSIGHT.body);
    expect(insight.model).toBe("kimi-test");
    expect(insight.prompt_version).toBe(INSIGHT_PROMPT_V1);
    expect(insight.source_refs).toContainEqual({
      kind: "document",
      id: documentId,
      note: "report.pdf",
    });
    expect(insight.source_refs).toContainEqual({
      kind: "biomarker_result",
      id: newResultId,
      note: "hemoglobin",
    });
    // The history row (not from this document) is NOT a source.
    expect(
      insight.source_refs.filter((ref) => ref.kind === "biomarker_result"),
    ).toHaveLength(1);
    expect(payload.insight).toMatchObject({
      id: insight.id,
      title: INSIGHT.title,
      promptVersion: INSIGHT_PROMPT_V1,
    });
  });

  it("never files a second insight for the same document on a re-run", async () => {
    const documentId = await insertDocument();
    const hemoglobin = await insertBiomarker("hemoglobin", "Hemoglobin");
    await insertResult(hemoglobin, {
      measuredOn: "2026-03-14",
      value: 14.2,
      documentId,
    });

    const stage = createSummarizeStage({
      sql,
      chatStructured: fakeChat([]),
    });
    const first = (await stage(ctxOf(documentId))) as Record<string, unknown>;
    const second = (await stage(ctxOf(documentId))) as Record<string, unknown>;

    expect(await insightRows(documentId)).toHaveLength(1);
    expect(second.insight).toMatchObject({
      id: (first.insight as { id: string }).id,
    });
  });

  it("skips the insight when the lab report persisted no results", async () => {
    const documentId = await insertDocument();
    const payload = (await createSummarizeStage({
      sql,
      chatStructured: fakeChat([]),
    })(ctxOf(documentId))) as Record<string, unknown>;

    expect(payload.insight).toBeNull();
    expect(payload.insightSkipped).toBe("no persisted results");
    expect(await insightRows(documentId)).toHaveLength(0);
  });

  it.each(["medical_doc", "wearable_export", "apple_health_export"])(
    "summarizes a %s document but files no insight (v1 rule)",
    async (documentType) => {
      const documentId = await insertDocument({
        documentType,
        extractedText: null,
        provider: null,
        documentDate: null,
      });
      const calls: ChatStructuredParams[] = [];
      const payload = (await createSummarizeStage({
        sql,
        chatStructured: fakeChat(calls),
      })(ctxOf(documentId, "export.dat"))) as Record<string, unknown>;

      // Only the summary call ran — never the insight call.
      expect(calls.map((c) => c.schema.name)).toEqual(["document_summary"]);
      expect(payload.insight).toBeNull();
      expect(payload.insightSkipped).toBe(
        `document type '${documentType}' gets no insight in v1`,
      );
      const docs = await sql<
        { ai_summary: string | null }[]
      >`select ai_summary from documents where id = ${documentId}`;
      expect(docs[0].ai_summary).toBe(SUMMARY);
    },
  );

  it("summarizes text-less documents from the pipeline digest", async () => {
    const documentId = await insertDocument({
      documentType: "apple_health_export",
      extractedText: null,
      provider: null,
      documentDate: null,
      filename: "export.xml",
    });
    await sql`
      insert into raw_extractions (document_id, stage, payload)
      values (
        ${documentId}, 'extracting',
        ${sql.json({ documentType: "apple_health_export", metrics: 123, workouts: 4 })}
      )
    `;
    const calls: ChatStructuredParams[] = [];
    await createSummarizeStage({ sql, chatStructured: fakeChat(calls) })(
      ctxOf(documentId, "export.xml"),
    );

    const summaryPrompt = calls[0].messages.at(-1)?.content as string;
    expect(summaryPrompt).toContain("Pipeline digest");
    expect(summaryPrompt).toContain('"metrics":123');
  });

  it("retries the summary call once with the validation error appended", async () => {
    const documentId = await insertDocument({
      documentType: "medical_doc",
    });
    const calls: ChatStructuredParams[] = [];
    const payload = (await createSummarizeStage({
      sql,
      chatStructured: fakeChat(calls, {
        summaryReplies: ["{not json", JSON.stringify({ summary: SUMMARY })],
      }),
    })(ctxOf(documentId))) as Record<string, unknown>;

    expect(calls).toHaveLength(2);
    const retryPrompt = calls[1].messages.at(-1)?.content as string;
    expect(retryPrompt).toContain("failed validation");
    expect(retryPrompt).toContain("not JSON");
    expect(payload.summary).toBe(SUMMARY);
  });

  it("throws when the summary reply fails validation twice", async () => {
    const documentId = await insertDocument();
    await expect(
      createSummarizeStage({
        sql,
        chatStructured: fakeChat([], {
          summaryReplies: ["{not json", "{still not json"],
        }),
      })(ctxOf(documentId)),
    ).rejects.toThrow(/failed validation twice/);
  });

  it("does not call Kimi for an insight the document already has", async () => {
    const documentId = await insertDocument();
    const hemoglobin = await insertBiomarker("hemoglobin", "Hemoglobin");
    await insertResult(hemoglobin, {
      measuredOn: "2026-03-14",
      value: 14.2,
      documentId,
    });
    // Pre-existing insight for this document (e.g. from an earlier run).
    await sql`
      insert into ai_insights (kind, title, body_md, source_refs)
      values (
        'post_ingestion', 'Existing insight', 'body',
        ${sql.json([{ kind: "document", id: documentId }])}
      )
    `;

    const calls: ChatStructuredParams[] = [];
    await createSummarizeStage({ sql, chatStructured: fakeChat(calls) })(
      ctxOf(documentId),
    );
    expect(calls.map((c) => c.schema.name)).toEqual(["document_summary"]);
    expect(await insightRows(documentId)).toHaveLength(1);
  });
});
