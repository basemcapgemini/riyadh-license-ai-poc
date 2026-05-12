import { fetchJson } from "./http";
import type { AttachmentAiValidation, BasicFormFields } from "../types";

export type AttachmentValidationResult = AttachmentAiValidation & {
  model: string;
  basicFields?: BasicFormFields;
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
}): Promise<AttachmentValidationResult> {
  return fetchJson<AttachmentValidationResult>(
    "/api/validate-attachment",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
    "فشل تشغيل التحقق الذكي من المرفق.",
  );
}
