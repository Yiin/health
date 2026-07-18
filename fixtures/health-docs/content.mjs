// Synthetic fixture content for the lab-extraction tests (worker/extract.test.ts).
// Shared between generate.mjs (renders the PDFs) and the tests (expectations),
// so the fixtures and the assertions can never drift apart.
//
// NOTHING here is real patient data — names/dates/values are invented.
//
// Analyte lines use 2+ spaces between columns on purpose: the mocked Kimi in
// the test parses the extracted text with a deterministic /\s{2,}/ split,
// standing in for the model. Keep that column discipline when editing lines.

export const EN_CBC = {
  filename: "en-cbc.pdf",
  labName: "City Central Laboratory",
  measuredOn: "2026-03-14",
  header: [
    "City Central Laboratory",
    "SYNTHETIC TEST PATIENT — DO NOT USE CLINICALLY",
    "Laboratory: City Central Laboratory",
    "Collected: 2026-03-14",
    "Report: Complete blood count + basic metabolic panel",
    "",
    "Name  Value  Unit  Reference",
  ],
  // name, value, unit, reference ("a-b", "<x", or ""), flag ("" | "H" | "L")
  analytes: [
    ["White blood cells", "6.1", "10^9/L", "4.0-10.0", ""],
    ["Red blood cells", "4.7", "10^12/L", "4.2-5.4", ""],
    ["Hemoglobin", "14.2", "g/dL", "12.0-16.0", ""],
    ["Hematocrit", "42.5", "%", "37.0-47.0", ""],
    ["MCV", "90.4", "fL", "80.0-100.0", ""],
    ["MCH", "30.2", "pg", "27.0-33.0", ""],
    ["MCHC", "33.4", "g/dL", "32.0-36.0", ""],
    ["Platelets", "245", "10^9/L", "150-400", ""],
    ["RDW", "13.1", "%", "11.5-14.5", ""],
    ["Glucose", "95", "mg/dL", "70-99", ""],
    ["Creatinine", "0.9", "mg/dL", "0.7-1.3", ""],
    ["ALT", "24", "U/L", "7-56", ""],
    ["TSH", "2.1", "mIU/L", "0.4-4.0", ""],
    ["Vitamin D (25-OH)", "78", "nmol/L", "75-250", ""],
    ["Ferritin", "88", "ug/L", "20-250", ""],
    ["Total cholesterol", "5.2", "mmol/L", "<5.2", ""],
    ["HDL cholesterol", "1.6", "mmol/L", "1.0-2.0", ""],
    ["LDL cholesterol", "3.1", "mmol/L", "<3.0", "H"],
    ["Triglycerides", "1.4", "mmol/L", "<1.7", ""],
    ["Carbamide", "6.1", "mmol/L", "2.5-7.1", ""],
    ["Homocysteine", "9.8", "umol/L", "5-15", ""],
  ],
};

export const LT_LAB = {
  filename: "lt-lab.pdf",
  labName: "SYNLAB Lietuva",
  measuredOn: "2026-04-02",
  header: [
    "SYNLAB Lietuva",
    "SINTETINIS TESTO PACIENTAS — NENAUDOTI KLINIKAI",
    "Laboratorija: SYNLAB Lietuva",
    "Mėginio data: 2026-04-02",
    "Tyrimas: Kraujo tyrimas",
    "",
    "Pavadinimas  Reikšmė  Vienetas  Referencija",
  ],
  analytes: [
    ["Hemoglobinas", "13,8", "g/dL", "12,0-16,0", ""],
    ["Eritrocitai", "4,5", "10^12/L", "4,2-5,4", ""],
    ["Leukocitai", "7,2", "10^9/L", "4,0-10,0", ""],
    ["Trombocitai", "260", "10^9/L", "150-400", ""],
    ["Hematokritas", "41,2", "%", "37,0-47,0", ""],
    ["Gliukozė", "5,4", "mmol/L", "3,9-5,5", ""],
    ["Kreatininas", "78", "µmol/L", "62-106", ""],
    ["Bendrasis cholesterinas", "5,1", "mmol/L", "<5,2", ""],
    ["Trigliceridai", "1,3", "mmol/L", "<1,7", ""],
    ["TTG", "1,8", "mTV/L", "0,4-4,0", ""],
    ["Kalcis", "2,35", "mmol/L", "2,10-2,60", ""],
  ],
};

/** The printed lines of a fixture: header + one line per analyte. */
export function fixtureLines(fixture) {
  return [
    ...fixture.header,
    ...fixture.analytes.map((a) =>
      [a[0], a[1], a[2], a[3], a[4]].filter(Boolean).join("  "),
    ),
  ];
}
