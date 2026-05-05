export type WorkflowStep = {
  id: string;
  actor: string;
  action: string;
  duration: string;
  phase: "office" | "municipality";
};

export type LicensePolicy = {
  id: string;
  title: string;
  category: "building" | "site-prep" | "demolition" | "renovation" | "transfer";
  references: string[];
  requiredDocuments: string[];
  workflow: WorkflowStep[];
  platform: string;
};

export type SubmissionForm = {
  applicantName: string;
  nationalId: string;
  officeName: string;
  officeLicense: string;
  mobile: string;
  district: string;
  plotNumber: string;
  projectDescription: string;
  selectedDocuments: string[];
  comments: string;
  uploadedAttachments: UploadedAttachment[];
};

export type AttachmentSourceType =
  | "pdf"
  | "docx"
  | "text"
  | "image"
  | "unknown";

export type AttachmentAnalysisTraceEvent = {
  id: string;
  operationKey?: string;
  phase: "upload" | "read" | "ocr" | "ai" | "match" | "done";
  status: "running" | "done" | "error";
  title: string;
  detail: string;
  fileName?: string;
  model?: string;
  detectedDocuments?: string[];
  responseSummary?: string;
};

export type UploadedAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  sourceType: AttachmentSourceType;
  extractedText: string;
  excerpt: string;
  detectedDocuments: string[];
  notes: string[];
};

export type EvidenceCitation = {
  id: string;
  category: "policy" | "required-document" | "workflow";
  label: string;
  matchedText: string;
  sourcePath: string;
  sourceFileName: string;
  excerpt: string;
};

export type LlmReviewDecision =
  | "approve-with-human-check"
  | "needs-more-info"
  | "reject-for-now";

export type DocumentValidationStatus = "passed" | "warning" | "missing";

export type DocumentValidation = {
  documentName: string;
  status: DocumentValidationStatus;
  summary: string;
  details: string[];
  evidenceSnippets?: string[];
  source?: "rule" | "ai";
};

export type SuggestedResponseActionType =
  | "request-completion"
  | "return-to-reviewer"
  | "escalate-to-supervisor";

export type SuggestedResponse = {
  actionType: SuggestedResponseActionType;
  title: string;
  text: string;
  rationale?: string;
  source?: "rule" | "ai";
};

export type LlmReview = {
  model: string;
  generatedAt: string;
  decision: LlmReviewDecision;
  confidence: number;
  summary: string;
  reasoning: string[];
  missingItems: string[];
  risks: string[];
  suggestedActions: string[];
  documentValidations: DocumentValidation[];
  suggestedResponses: SuggestedResponse[];
  evidence: Array<{
    label: string;
    sourcePath: string;
    excerpt: string;
    relevance: string;
  }>;
};

export type ReviewResult = {
  score: number;
  status: "ready" | "needs-info" | "blocked";
  summary: string;
  missingDocuments: string[];
  matchedDocuments: string[];
  policyAlerts: string[];
  documentValidations: DocumentValidation[];
  suggestedResponses: SuggestedResponse[];
  nextStep: string;
  sourcePath: string;
  evidence: EvidenceCitation[];
  documentEvidence: EvidenceCitation[];
  workflowEvidence: EvidenceCitation[];
};

export type ApplicationRecord = {
  id: string;
  policyId: string;
  submittedAt: string;
  source: "seed" | "portal";
  applicantName: string;
  officeName: string;
  district: string;
  plotNumber: string;
  projectDescription: string;
  selectedDocuments: string[];
  comments: string;
  uploadedAttachments: UploadedAttachment[];
  llmReview?: LlmReview | null;
  review: ReviewResult;
};
