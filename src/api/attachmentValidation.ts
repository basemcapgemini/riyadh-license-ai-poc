import { fetchJson } from "./http";
import type { AttachmentAiValidation } from "../types";
import type { Locale } from "../utils/localization";

export type AttachmentValidationResult = AttachmentAiValidation & {
  model: string;
};

export async function requestAttachmentValidation(input: {
  fileName: string;
  mimeType: string;
  sourceType: string;
  requiredDocuments: string[];
  expectedDocument?: string;
  extractedText: string;
  detectedDocuments: string[];
  notes: string[];
  locale: Locale;
}): Promise<AttachmentValidationResult> {
  return fetchJson<AttachmentValidationResult>(
    "/api/validate-attachment",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
    input.locale === "en"
      ? "Failed to run AI attachment validation."
      : "فشل تشغيل التحقق الذكي من المرفق.",
    input.locale,
  );
}
