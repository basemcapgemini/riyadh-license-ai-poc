import { fetchJson } from "./http";
import type { BasicFormFields } from "../types";

export type AttachmentExtractionResult = {
  model: string;
  confidence: number;
  extractedText: string;
  detectedDocuments: string[];
  notes: string[];
  basicFields?: BasicFormFields;
};

export async function requestAttachmentExtraction(input: {
  fileName: string;
  mimeType: string;
  requiredDocuments: string[];
  localExtractedText: string;
  extractionMode?: "standard" | "cad-critical";
  purpose?: "standard" | "basic-fields";
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
    "فشل تشغيل الاستخراج الذكي للمرفق.",
  );
}
