import type {
  AttachmentChecklistResult,
  FirstLayerComplianceSnapshot,
  LicensePolicy,
  LlmReview,
  ReviewResult,
  SubmissionForm,
} from "../types";
import { fetchJson } from "./http";

export async function requestLlmReview(input: {
  policy: LicensePolicy;
  submission: SubmissionForm;
  ruleReview: ReviewResult;
  firstLayerArchitecturalChecklistResults?: AttachmentChecklistResult[];
  firstLayerComplianceSnapshot?: FirstLayerComplianceSnapshot;
}): Promise<LlmReview> {
  return fetchJson<LlmReview>(
    "/api/llm-review",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
    "فشل تشغيل مراجعة LLM.",
  );
}
