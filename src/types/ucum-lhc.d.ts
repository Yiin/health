// Minimal typings for @lhncbc/ucum-lhc (the package ships no .d.ts).
// Only the surface src/lib/units.ts uses is declared.
declare module "@lhncbc/ucum-lhc" {
  export interface UcumValidationResult {
    status: "valid" | "invalid" | "error";
    msg: string[];
    ucumCode?: string | null;
    unit?: { code: string; name: string } | null;
  }

  export interface UcumConversionResult {
    status: "succeeded" | "failed" | "error";
    toVal: number | null;
    msg: string[];
  }

  export class UcumLhcUtils {
    static getInstance(): UcumLhcUtils;
    validateUnitString(code: string): UcumValidationResult;
    convertUnitTo(
      fromCode: string,
      fromVal: number,
      toCode: string,
    ): UcumConversionResult;
  }
}
