// Focused tests of the normalizing stage's mapping behavior, driving the
// stage runner directly (no executor): catalog match order, LLM fallback
// validation/retry, alias write-back dedup, and unmapped-analyte handling.

import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { BIOMARKER_SEED } from "../src/db/seed/biomarkers";
import { setupTestDb, TEST_DATABASE_URL } from "../src/db/test-utils";
import type { ChatStructuredParams } from "../src/lib/kimi/client";

import type { StageContext } from "./ingestion";
import { createNormalizeStage, mapWithKimi } from "./normalize";

setupTestDb();

let sql: postgres.Sql;
beforeAll(() => {
  sql = postgres(TEST_DATABASE_URL, { max: 2 });
});
beforeEach(async () => {
  for (const b of BIOMARKER_SEED) {
    await sql`
      insert into biomarkers
        (slug, name, aliases, category, canonical_unit, loinc_code, molar_mass_g_mol)
      values (
        ${b.slug}, ${b.name}, ${b.aliases}, ${b.category},
        ${b.canonicalUnit}, ${b.loincCode ?? null}, ${b.molarMassGMol ?? null}
      )
      on conflict (slug) do nothing
    `;
  }
});
afterAll(async () => {
  await sql.end();
});

function ctxOf(documentId: string): StageContext {
  return {
    documentId,
    sha256: "ab".repeat(32),
    originalFilename: "report.pdf",
    attempt: 1,
  };
}

const NEVER_CALLED = async (): Promise<string> => {
  throw new Error("chatStructured must not be called in this test");
};

async function insertDocWithExtraction(
  extraction: unknown,
  documentType = "lab_report",
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into documents (sha256, original_filename, s3_key, status, document_type)
    values (
      ${crypto.randomUUID()}, 'report.pdf', 'originals//ab/fixture',
      'extracting', ${documentType}
    )
    returning id
  `;
  await sql`
    insert into raw_extractions (document_id, stage, payload)
    values (
      ${rows[0].id}, 'extracting',
      ${sql.json({ promptVersion: "lab-extract-v1", extraction } as unknown as postgres.JSONValue)}
    )
  `;
  return rows[0].id;
}

function biomarker(name: string, value = 1, unit = "mmol/L") {
  return {
    name,
    value,
    unit,
    referenceLow: null,
    referenceHigh: null,
    referenceText: null,
    flag: null,
  };
}

const EXTRACTION = {
  measuredAt: "2026-03-14",
  labName: "City Central Laboratory",
  biomarkers: [
    biomarker("Hemoglobin", 14.2, "g/dL"), // exact alias
    biomarker("TTG", 1.8, "mIU/L"), // fuzzy via 'tth'
    biomarker("Carbamide", 6.1), // LLM only
    biomarker("Homocysteine", 9.8, "umol/L"), // unmappable
  ],
};

function mappingChat(
  calls: string[],
  reply: Record<string, unknown>,
): {
  calls: string[];
  chat: (params: ChatStructuredParams) => Promise<string>;
} {
  const chat = async (params: ChatStructuredParams): Promise<string> => {
    const userContent = params.messages.at(-1)?.content as string;
    calls.push(userContent);
    return JSON.stringify(reply);
  };
  return { calls, chat };
}

describe("normalizing stage", () => {
  it("maps exact → fuzzy → LLM, writes back the LLM alias, persists rows", async () => {
    const id = await insertDocWithExtraction(EXTRACTION);
    const { calls, chat } = mappingChat([], {
      mappings: [
        { name: "Carbamide", slug: "bun" },
        { name: "Homocysteine", slug: null },
      ],
    });
    const payload = (await createNormalizeStage({
      sql,
      chatStructured: chat,
    })(ctxOf(id))) as Record<string, unknown>;

    expect(payload.total).toBe(4);
    expect(payload.mappedExact).toBe(1);
    expect(payload.mappedFuzzy).toBe(1);
    expect(payload.mappedLlm).toBe(1);
    expect(payload.unmapped).toEqual(["Homocysteine"]);
    expect(payload.aliasWritebacks).toEqual([
      { name: "Carbamide", slug: "bun" },
    ]);
    expect(payload.inserted).toBe(3);

    const bun = await sql<{ aliases: string[] }[]>`
      select aliases from biomarkers where slug = 'bun'
    `;
    expect(bun[0].aliases).toContain("carbamide");

    const rows = await sql<
      { slug: string; value: number; document_id: string | null }[]
    >`
      select b.slug, r.value::float8 as value, r.document_id
      from biomarker_results r join biomarkers b on b.id = r.biomarker_id
      order by b.slug
    `;
    expect(rows.map((r) => r.slug)).toEqual(["bun", "hemoglobin", "tsh"]);
    expect(rows.every((r) => r.document_id === id)).toBe(true);
    expect(calls).toHaveLength(1); // one batched mapping call
    expect(calls[0]).toContain('"Carbamide"');
    expect(calls[0]).toContain('"Homocysteine"');
    expect(calls[0]).not.toContain('"Hemoglobin"');
  });

  it("leaves the pool's json serializers intact (drizzle hijack regression)", async () => {
    const id = await insertDocWithExtraction(EXTRACTION);
    const { chat } = mappingChat([], {
      mappings: [
        { name: "Carbamide", slug: "bun" },
        { name: "Homocysteine", slug: null },
      ],
    });
    await createNormalizeStage({ sql, chatStructured: chat })(ctxOf(id));
    // drizzle() replaces the pool's json/jsonb serializers with identity
    // functions when it wraps an existing pool; the stage must restore them,
    // or this sql.json() bind throws (and the executor's raw_extractions
    // insert would crash in production right after the normalize stage).
    await sql`
      insert into raw_extractions (document_id, stage, payload)
      values (${id}, 'normalizing', ${sql.json({ ok: true })})
    `;
  });

  it("never calls the LLM when every name matches deterministically", async () => {
    const id = await insertDocWithExtraction({
      ...EXTRACTION,
      biomarkers: [biomarker("Hemoglobin", 14.2, "g/dL")],
    });
    const payload = (await createNormalizeStage({
      sql,
      chatStructured: NEVER_CALLED,
    })(ctxOf(id))) as Record<string, unknown>;
    expect(payload.inserted).toBe(1);
    expect(payload.mappedExact).toBe(1);
  });

  it("tolerates LLM mappings for unknown slugs and missing names", async () => {
    const id = await insertDocWithExtraction({
      ...EXTRACTION,
      biomarkers: [
        biomarker("Carbamide", 6.1),
        biomarker("Homocysteine", 9.8, "umol/L"),
      ],
    });
    const { chat } = mappingChat([], {
      mappings: [
        { name: "Carbamide", slug: "no-such-slug" },
        { name: "Something else entirely", slug: "bun" },
      ],
    });
    const payload = (await createNormalizeStage({
      sql,
      chatStructured: chat,
    })(ctxOf(id))) as Record<string, unknown>;
    // Bogus slug is not honored; missing names default to unmapped.
    expect(payload.unmapped).toEqual(["Carbamide", "Homocysteine"]);
    expect(payload.inserted).toBe(0);
  });

  it("retries the mapping call once on an invalid reply, then throws", async () => {
    const id = await insertDocWithExtraction(EXTRACTION);
    let callCount = 0;
    const chat = async (): Promise<string> => {
      callCount += 1;
      return "{garbled";
    };
    await expect(
      createNormalizeStage({ sql, chatStructured: chat })(ctxOf(id)),
    ).rejects.toThrow(/failed validation twice/);
    expect(callCount).toBe(2);
  });

  it("does not duplicate an alias that is already stored", async () => {
    await sql`
      update biomarkers set aliases = array_append(aliases, 'carbamide')
      where slug = 'bun'
    `;
    const id = await insertDocWithExtraction(EXTRACTION);
    const { chat } = mappingChat([], {
      mappings: [
        { name: "Carbamide", slug: "bun" },
        { name: "Homocysteine", slug: null },
      ],
    });
    await createNormalizeStage({ sql, chatStructured: chat })(ctxOf(id));
    const bun = await sql<{ aliases: string[] }[]>`
      select aliases from biomarkers where slug = 'bun'
    `;
    expect(bun[0].aliases.filter((a) => a === "carbamide")).toHaveLength(1);
  });

  it("handles an extraction with zero analytes without LLM calls", async () => {
    const id = await insertDocWithExtraction({
      measuredAt: "2026-03-14",
      labName: "",
      biomarkers: [],
    });
    const payload = (await createNormalizeStage({
      sql,
      chatStructured: NEVER_CALLED,
    })(ctxOf(id))) as Record<string, unknown>;
    expect(payload).toMatchObject({ total: 0, inserted: 0, skipped: 0 });
  });

  it("throws when the extracting payload is missing (out-of-order run)", async () => {
    const rows = await sql<{ id: string }[]>`
      insert into documents (sha256, original_filename, s3_key, status, document_type)
      values (
        ${crypto.randomUUID()}, 'report.pdf', 'originals//ab/fixture',
        'extracting', 'lab_report'
      )
      returning id
    `;
    await expect(
      createNormalizeStage({ sql, chatStructured: NEVER_CALLED })(
        ctxOf(rows[0].id),
      ),
    ).rejects.toThrow(/extracting.*payload/i);
  });

  it("skips non-lab documents", async () => {
    const id = await insertDocWithExtraction(EXTRACTION, "wearable_export");
    const payload = (await createNormalizeStage({
      sql,
      chatStructured: NEVER_CALLED,
    })(ctxOf(id))) as Record<string, unknown>;
    expect(payload).toMatchObject({
      skipped: true,
      documentType: "wearable_export",
    });
  });
});

describe("mapWithKimi", () => {
  it("retries once with the validation error appended and succeeds", async () => {
    const replies = ["{bad", JSON.stringify({ mappings: [] })];
    const seen: string[] = [];
    const chat = async (params: ChatStructuredParams): Promise<string> => {
      seen.push(params.messages.at(-1)?.content as string);
      return replies[seen.length - 1];
    };
    const mapping = await mapWithKimi(
      chat,
      "kimi-k2.6",
      [biomarker("Carbamide", 6.1)],
      [],
    );
    expect(mapping.mappings).toEqual([]);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain("failed validation");
  });
});
