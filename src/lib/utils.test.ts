import { describe, expect, it } from "vitest";

import { cn } from "./utils";

describe("cn", () => {
  it("merges conflicting tailwind classes, keeping the last one", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
  });

  it("joins non-conflicting classes", () => {
    expect(cn("px-2", "text-white")).toBe("px-2 text-white");
  });

  it("handles conditional and falsy inputs", () => {
    expect(cn("px-2", false && "px-4", undefined)).toBe("px-2");
  });
});
