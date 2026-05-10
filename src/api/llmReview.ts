import type {
  LicensePolicy,
  LlmReview,
  ReviewResult,
  SubmissionForm,
} from "../types";
import { fetchJson } from "./http";
import type { Locale } from "../utils/localization";

export async function requestLlmReview(input: {
  policy: LicensePolicy;
  submission: SubmissionForm;
  ruleReview: ReviewResult;
  locale: Locale;
}): Promise<LlmReview> {
  return fetchJson<LlmReview>(
    "/api/llm-review",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
    input.locale === "en"
      ? "Failed to run the LLM review."
      : "فشل تشغيل مراجعة LLM.",
    input.locale,
  );
}
