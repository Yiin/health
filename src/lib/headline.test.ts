import { describe, expect, test } from "vitest";

import { sanitizeHeadline } from "./headline";

describe("sanitizeHeadline", () => {
  test("keeps ts_headline <b> highlight tags", () => {
    expect(sanitizeHeadline("mildly elevated <b>LDL</b> cholesterol")).toBe(
      "mildly elevated <b>LDL</b> cholesterol",
    );
  });

  test("escapes markup coming from the source document", () => {
    expect(sanitizeHeadline('<script>alert("x")</script> <b>glucose</b>')).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; <b>glucose</b>",
    );
  });

  test("escapes ampersands before restoring highlight tags", () => {
    expect(sanitizeHeadline("R&D <b>results</b>")).toBe(
      "R&amp;D <b>results</b>",
    );
  });

  test("escapes single quotes", () => {
    expect(sanitizeHeadline("it's <b>here</b>")).toBe("it&#39;s <b>here</b>");
  });

  test("leaves plain text untouched", () => {
    expect(sanitizeHeadline("no markup at all")).toBe("no markup at all");
  });
});
