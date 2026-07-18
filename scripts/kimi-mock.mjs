// Deterministic Moonshot/Kimi API stand-in for the compose e2e stack
// (docker-compose.e2e.yml). Zero dependencies — plain node:http — so it runs
// in a bare node image with only this file mounted.
//
// Implements exactly the surface src/lib/kimi uses:
//   POST   /v1/files                  (multipart; purpose=file-extract|image)
//   GET    /v1/files/:id/content      (extracted text of an upload)
//   DELETE /v1/files/:id
//   POST   /v1/chat/completions       (response_format json_schema)
// plus a control plane for the e2e script:
//   GET/POST /__mock/mode             {"mode":"ok"|"outage"}
//
// In outage mode every /v1/* request answers 503, mirroring a Moonshot
// incident; the control plane keeps working so the e2e script can restore
// connectivity.
//
// Chat replies are dispatched on the json_schema name and derived
// deterministically from the request content (the same column discipline the
// worker/extract.test.ts mock uses), so the e2e assertions and the fixtures
// can never drift apart.

import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 9700);

// Lab fixture ground truth (analyte tables of the committed PDF fixtures) —
// the extraction reply for PDFs is derived from it, exactly like the unit
// tests' mockKimi, because unpdf flattens the PDF text layer to a single
// line and the column structure is unrecoverable from the prompt alone.
const FIXTURES_DIR = process.env.FIXTURES_DIR ?? "/mock/fixtures/health-docs";
const { EN_CBC, LT_LAB } = await import(`${FIXTURES_DIR}/content.mjs`);
const LAB_FIXTURES = [EN_CBC, LT_LAB];

/** "ok" | "outage" — toggled by the e2e script via POST /__mock/mode. */
let mode = "ok";

/** fileId → original filename of the upload. */
const files = new Map();
let nextFileId = 1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Minimal multipart/form-data reader: field values + file part filenames.
 * File BYTES are ignored — the mock answers from filenames alone.
 */
function parseMultipart(body, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType ?? "");
  if (!match) return { fields: {}, filenames: [] };
  const boundary = `--${match[1] ?? match[2]}`;
  const fields = {};
  const filenames = [];
  for (const part of body.toString("latin1").split(boundary)) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd < 0) continue;
    const headers = part.slice(0, headerEnd);
    const disposition = /content-disposition:[^\n]*/i.exec(headers)?.[0] ?? "";
    const filename = /filename="([^"]*)"/.exec(disposition)?.[1];
    const name = /name="([^"]*)"/.exec(disposition)?.[1];
    if (filename !== undefined) {
      filenames.push(Buffer.from(filename, "latin1").toString("utf-8"));
    } else if (name) {
      fields[name] = part.slice(headerEnd + 4).replace(/\r\n$/, "");
    }
  }
  return { fields, filenames };
}

// ---------------------------------------------------------------------------
// Canned file-extract text (classification reads PDFs through this)
// ---------------------------------------------------------------------------

/** Filenames Moonshot would reject at upload: no text layer (scanned). */
function hasNoTextLayer(filename) {
  return /scanned/i.test(filename);
}

/**
 * The classifier only needs enough text to recognize the document; these
 * markers line up with the chat heuristics below and with the real text
 * layers of fixtures/health-docs/.
 */
function extractedTextFor(filename) {
  if (/lt-lab/i.test(filename)) {
    return [
      "SYNLAB Lietuva",
      "Laboratorija: SYNLAB Lietuva",
      "Mėginio data: 2026-04-02",
      "Tyrimas: Kraujo tyrimas",
      "Hemoglobinas  13,8  g/dL  12,0-16,0",
    ].join("\n");
  }
  return [
    "City Central Laboratory",
    "Laboratory: City Central Laboratory",
    "Collected: 2026-03-14",
    "Report: Complete blood count",
    "Hemoglobin  14.2  g/dL  12.0-16.0",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Chat completions: dispatch on the json_schema name
// ---------------------------------------------------------------------------

function classificationReply(userContent) {
  if (userContent.includes("City Central Laboratory")) {
    return {
      docType: "lab_report",
      language: "en",
      confidence: 0.95,
      summary: "Blood panel from City Central Laboratory (e2e mock).",
    };
  }
  if (userContent.includes("SYNLAB Lietuva")) {
    return {
      docType: "lab_report",
      language: "lt",
      confidence: 0.95,
      summary: "Kraujo tyrimas iš SYNLAB Lietuva (e2e mock).",
    };
  }
  // The classifier fell back to the raw byte head — a PDF whose text layer
  // yielded nothing, i.e. a scan. Classify confidently as lab_report so the
  // extracting stage discovers the scanned halt through unpdf, exactly like
  // production would.
  if (userContent.includes("First 4 KB of the file")) {
    return {
      docType: "lab_report",
      language: "en",
      confidence: 0.9,
      summary: "Scanned laboratory report (e2e mock).",
    };
  }
  return {
    docType: "unknown",
    language: "en",
    confidence: 0.95,
    summary: "Not a health document (e2e mock).",
  };
}

/** "12,0-16,0" | "<5,2" | "" → reference fields (null-filled for strict). */
function referenceFields(ref) {
  const base = { referenceLow: null, referenceHigh: null, referenceText: null };
  if (!ref) return base;
  if (ref.startsWith("<") || ref.startsWith(">")) {
    return { ...base, referenceText: ref };
  }
  const [low, high] = ref.split("-");
  const parsed = {
    referenceLow: Number(low.replace(",", ".")),
    referenceHigh: Number(high?.replace(",", ".")),
  };
  if (
    !Number.isFinite(parsed.referenceLow) ||
    !Number.isFinite(parsed.referenceHigh)
  ) {
    return { ...base, referenceText: ref };
  }
  return { ...base, ...parsed };
}

function fixtureBiomarker([name, value, unit, ref, flag]) {
  return {
    name,
    value: Number(value.replace(",", ".")),
    unit,
    ...referenceFields(ref),
    flag: flag === "H" ? "high" : flag === "L" ? "low" : null,
  };
}

/**
 * Deterministic "extraction", three strategies:
 * 1. Line parsing with the fixtures' 2+-space column discipline
 *    (name  value  unit  reference  flag) — works for plain-text documents,
 *    whose newlines survive into the prompt.
 * 2. Fixture ground truth for the PDF fixtures — unpdf flattens their text
 *    layer to one newline-less line, so (mirroring the unit tests' mockKimi)
 *    the reply is the fixture's analytes whose names actually appear in the
 *    extracted text.
 * 3. Vision requests (page images of a scan) carry NO document text at all —
 *    only the instruction part's "Filename:" line identifies the document, so
 *    the reply is keyed on the image-only fixtures' filenames. The blank
 *    scanned.pdf matches nothing and yields an empty extraction, which the
 *    worker parks in needs_review ("no biomarkers in scan").
 */
function labExtractionReply(userContent) {
  const filename = /Filename:\s*(\S+)/.exec(userContent)?.[1] ?? "";
  if (/scanned-lab/i.test(filename)) {
    // Image-only render of the EN report (fixtures/health-docs/generate.mjs).
    return {
      measuredAt: EN_CBC.measuredOn,
      labName: EN_CBC.labName,
      biomarkers: EN_CBC.analytes.map(fixtureBiomarker),
    };
  }
  if (/lab-photo/i.test(filename)) {
    // JPEG photo of the LT report.
    return {
      measuredAt: LT_LAB.measuredOn,
      labName: LT_LAB.labName,
      biomarkers: LT_LAB.analytes.map(fixtureBiomarker),
    };
  }
  const biomarkers = [];
  for (const line of userContent.split("\n")) {
    const columns = line.trim().split(/\s{2,}/);
    if (columns.length < 3) continue;
    const value = Number(columns[1].replace(",", "."));
    if (!Number.isFinite(value)) continue;
    biomarkers.push(
      fixtureBiomarker([
        columns[0],
        columns[1],
        columns[2],
        columns[3] ?? "",
        columns[4] ?? "",
      ]),
    );
  }
  if (biomarkers.length >= 2) {
    return {
      measuredAt:
        /(?:Collected|Mėginio data):\s*(\d{4}-\d{2}-\d{2})/.exec(
          userContent,
        )?.[1] ?? "2026-01-01",
      labName:
        /(?:Laboratory|Laboratorija):\s*([^\n]+?)(?:\n|$)/
          .exec(userContent)?.[1]
          ?.trim() ?? "",
      biomarkers,
    };
  }

  const fixture = LAB_FIXTURES.find((candidate) =>
    userContent.includes(candidate.labName),
  );
  if (!fixture) return { measuredAt: "2026-01-01", labName: "", biomarkers };
  return {
    measuredAt: fixture.measuredOn,
    labName: fixture.labName,
    biomarkers: fixture.analytes
      .filter(([name]) => userContent.includes(name))
      .map(fixtureBiomarker),
  };
}

function biomarkerMappingReply(userContent) {
  const names = [...userContent.matchAll(/- "([^"]+)" \(unit:/g)].map(
    (m) => m[1],
  );
  return { mappings: names.map((name) => ({ name, slug: null })) };
}

/**
 * User-message content → text. Vision requests carry an array of parts
 * (text instruction + ms:// image_url references); only the text parts
 * matter to the deterministic dispatch.
 */
function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === "text")
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}

function chatReply(body) {
  const schemaName = body?.response_format?.json_schema?.name ?? "";
  const userContent = contentText(
    body?.messages?.filter((m) => m.role === "user").at(-1)?.content,
  );
  switch (schemaName) {
    case "health_document_classification":
      return classificationReply(userContent);
    case "lab_extraction":
      return labExtractionReply(userContent);
    case "biomarker_mapping":
      return biomarkerMappingReply(userContent);
    case "document_summary":
      return { summary: "Deterministic e2e mock summary of the document." };
    case "post_ingestion_insight":
      return {
        title: "E2E mock insight",
        body: "Deterministic insight generated by the kimi-mock server.",
      };
    default:
      return { error: `kimi-mock: unexpected schema '${schemaName}'` };
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname;

  try {
    // Control plane — always available, even mid-outage.
    if (path === "/__mock/mode") {
      if (req.method === "POST") {
        const body = JSON.parse((await readBody(req)).toString() || "{}");
        if (body.mode !== "ok" && body.mode !== "outage") {
          return json(res, 400, { error: "mode must be 'ok' or 'outage'" });
        }
        mode = body.mode;
        console.log(`[kimi-mock] mode → ${mode}`);
      }
      return json(res, 200, { mode });
    }

    if (!path.startsWith("/v1/")) {
      return json(res, 404, { error: { message: `no route for ${path}` } });
    }

    if (mode === "outage") {
      return json(res, 503, {
        error: { message: "kimi-mock simulated outage" },
      });
    }

    if (path === "/v1/files" && req.method === "POST") {
      const body = await readBody(req);
      const { fields, filenames } = parseMultipart(
        body,
        req.headers["content-type"],
      );
      const filename = filenames[0] ?? "unnamed";
      if (fields.purpose === "file-extract" && hasNoTextLayer(filename)) {
        // Moonshot rejects image-only PDFs at upload time with this message.
        return json(res, 400, {
          error: { message: "text extract error: 没有解析出内容" },
        });
      }
      const id = `mock-file-${nextFileId++}`;
      files.set(id, filename);
      console.log(`[kimi-mock] upload ${filename} → ${id}`);
      return json(res, 200, { id, filename });
    }

    const contentMatch = /^\/v1\/files\/([^/]+)\/content$/.exec(path);
    if (contentMatch && req.method === "GET") {
      const filename = files.get(contentMatch[1]);
      if (filename === undefined) {
        return json(res, 404, { error: { message: "file not found" } });
      }
      return json(res, 200, { content: extractedTextFor(filename) });
    }

    const fileMatch = /^\/v1\/files\/([^/]+)$/.exec(path);
    if (fileMatch && req.method === "DELETE") {
      files.delete(fileMatch[1]);
      return json(res, 200, { deleted: true });
    }

    if (path === "/v1/chat/completions" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString());
      const reply = chatReply(body);
      console.log(
        `[kimi-mock] chat ${body?.response_format?.json_schema?.name ?? "?"}`,
      );
      return json(res, 200, {
        id: `mock-${Date.now()}`,
        object: "chat.completion",
        model: body.model ?? "kimi-mock",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: JSON.stringify(reply) },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }

    return json(res, 404, {
      error: { message: `no route for ${req.method} ${path}` },
    });
  } catch (error) {
    console.error("[kimi-mock] error:", error);
    return json(res, 500, { error: { message: String(error) } });
  }
});

server.listen(PORT, () => {
  console.log(`[kimi-mock] listening on :${PORT} (mode ${mode})`);
});
