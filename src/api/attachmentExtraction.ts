import { fetchJson } from "./http";
import type { Locale } from "../utils/localization";

export type AttachmentExtractionResult = {
  model: string;
  confidence: number;
  extractedText: string;
  detectedDocuments: string[];
  notes: string[];
};

export async function requestAttachmentExtraction(input: {
  fileName: string;
  mimeType: string;
  requiredDocuments: string[];
  localExtractedText: string;
  extractionMode?: "standard" | "cad-critical";
  locale: Locale;
  pageImages: Array<{
    pageNumber: number;
    dataUrl: string;
  }>;
}): Promise<AttachmentExtractionResult> {
  return fetchJson<AttachmentExtractionResult>(
    "/api/extract-attachment",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
    input.locale === "en"
      ? "Failed to run AI attachment extraction."
      : "فشل تشغيل الاستخراج الذكي للمرفق.",
    input.locale,
  );
}
