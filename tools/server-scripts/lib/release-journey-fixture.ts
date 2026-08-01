// Tracked release journey input fixture.
//
// The release journey gate uploads this UTF-8 Chinese plain-text document to
// prove that the containerized file-parser/format-convert service renders CJK
// text into a real PDF (embedded Noto CJK glyphs, full ToUnicode coverage).
// The bytes are pinned by RELEASE_JOURNEY_FIXTURE_SHA256 so the gate detects
// any accidental fixture drift.
export const RELEASE_JOURNEY_FIXTURE_FILENAME: any = "chinese-input.txt";
export const RELEASE_JOURNEY_FIXTURE_SHA256: any = "36c5d00309034a0b59d83efd8698c5366b8e7a6674ae80cfcbe31171ee0583a8";
export const RELEASE_JOURNEY_FIXTURE_BYTES: any = Buffer.from(
  "5qC85byP6L2s5o2i5pyN5Yqh5Lit5paH6aqM5pS25qC35L6LCgrnrKzkuIDmrrXvvJpNZXNocml4IOagvOW8j+i9rOaNouacjeWKoeWwhiBVVEYtOCDnuq/mlofmnKzmlofmoaPovazmjaLkuLogRE9DWCDmiJYgUERG44CC5pys5qC35L6L55So5LqO6aqM6K+B5a655Zmo6ZWc5YOP5Lit55qEIE5vdG8gQ0pLIOWtl+S9k+iDveWkn+ato+ehrua4suafk+S4reaWh++8jOS4jeWGjeWHuueOsOe8uuWtl+aWueWdl+OAggoK56ys5LqM5q6177ya5Lit5paH5a2X5L2T5riy5p+T5L6d6LWW5LqO6ZWc5YOP5YaF5a6J6KOF55qEIGZvbnRzLW5vdG8tY2prIOi9r+S7tuWMheOAgkxpYnJlT2ZmaWNlIFdyaXRlciDlnKjnlJ/miJAgUERGIOaXtuS8muWvuSBMaWJlcmF0aW9uIFNlcmlmIOaXoOazleimhueblueahOaxieWtl+Wtl+espuWbnumAgOWIsCBOb3RvIENKSyDlrZfkvZPvvIzku47ogIzkv53or4HliIbpobXkuI7mjaLooYznmoTnoa7lrprmgKfjgIIKCuesrOS4ieaute+8mumqjOaUtuajgOafpeWMheaLrCBIVFRQIOeKtuaAgeeggeOAgVNIQS0yNTYgRGlnZXN0IOWTjeW6lOWktOOAgVBERiDmlofku7bprZTmlbDku6Xlj4rltYzlhaXlrZfkvZPlkI3np7DjgILlpKfpgZPoh7PnroDvvIznn6XooYzlkIjkuIDjgIIK",
  "base64"
);
export const RELEASE_JOURNEY_FIXTURE_TEXT: any = RELEASE_JOURNEY_FIXTURE_BYTES.toString("utf8");
