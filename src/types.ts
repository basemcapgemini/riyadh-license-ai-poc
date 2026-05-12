export type WorkflowStep = {
  id: string;
  actor: string;
  action: string;
  duration: string;
  phase: "office" | "municipality";
};

export type ProjectSubtype = {
  id: string;
  title: string;
  sourceCode?: string;
  requiredDocuments?: string[];
};

export type ProjectTypeGroup = {
  id: string;
  title: string;
  sourceCode?: string;
  subtypes: ProjectSubtype[];
};

export type LicensePolicy = {
  id: string;
  title: string;
  category: "building" | "site-prep" | "demolition" | "renovation" | "transfer";
  references: string[];
  requiredDocuments: string[];
  workflow: WorkflowStep[];
  platform: string;
  projectTypes?: ProjectTypeGroup[];
};

export type SubmissionForm = {
  applicantName: string;
  nationalId: string;
  officeName: string;
  officeLicense: string;
  mobile: string;
  district: string;
  plotNumber: string;
  projectTypeGroupId: string;
  projectSubtypeId: string;
  projectDescription: string;
  selectedDocuments: string[];
  comments: string;
  uploadedAttachments: UploadedAttachment[];
};

export type BasicFormFields = {
  applicantName: string;
  nationalId: string;
  officeName: string;
  officeLicense: string;
  district: string;
  plotNumber: string;
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
  requiredDocument?: string;
  name: string;
  mimeType: string;
  size: number;
  sourceType: AttachmentSourceType;
  extractedText: string;
  excerpt: string;
  detectedDocuments: string[];
  notes: string[];
  preview?: AttachmentPreview;
  aiValidation?: AttachmentAiValidation;
  basicFields?: BasicFormFields;
};

export type AttachmentPreview = {
  fileName: string;
  kind: "pdf" | "html" | "image" | "unsupported";
  url?: string;
  html?: string;
  message?: string;
  revokeObjectUrl?: boolean;
};

export type AttachmentAiValidationStatus = "passed" | "warning" | "missing";

export type AttachmentChecklistReviewStatus =
  | "Compliant"
  | "Non-Compliant"
  | "Not Found";

export type AttachmentChecklistResult = {
  item: string;
  status: AttachmentChecklistReviewStatus;
  comment: string;
};

export type AttachmentAiValidation = {
  status: AttachmentAiValidationStatus;
  summary: string;
  feedback: string[];
  confidence: number;
  model?: string;
  checklistResults?: AttachmentChecklistResult[];
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

export type ComplianceConfidenceLevel = "High" | "Medium" | "Low";

export type ComplianceAttachmentStatus =
  | "Present"
  | "Missing"
  | "Invalid / Unclear";

export type ComplianceDataConsistencyStatus = "Match" | "Mismatch" | "Missing";

export type ComplianceAttachmentAccuracyStatus =
  | "Valid"
  | "Invalid"
  | "Partially Valid";

export type ComplianceRequirementsStatus = "Compliant" | "Not Compliant";

export type ComplianceChecklistStatus =
  | "Compliant"
  | "Non-Compliant"
  | "Not Found";

export type ComplianceOverallStatus = "Complete" | "Incomplete";

export type ComplianceAttachmentRow = {
  attachment: string;
  status: ComplianceAttachmentStatus;
  notes: string;
  sourceRefs?: string[];
};

export type ComplianceDataConsistencyRow = {
  field: string;
  sak: string;
  otherDocs: string;
  status: ComplianceDataConsistencyStatus;
  sourceRefs?: string[];
};

export type ComplianceChecklistRow = {
  item: string;
  status: ComplianceChecklistStatus;
  comment: string;
  sourceRefs?: string[];
};

export type ComplianceReport = {
  projectInformation: {
    projectType: string;
    confidenceLevel: ComplianceConfidenceLevel;
  };
  attachmentsStatus: {
    overallStatus: ComplianceOverallStatus;
    rows: ComplianceAttachmentRow[];
  };
  dataConsistencyCheck: ComplianceDataConsistencyRow[];
  attachmentAccuracy: {
    status: ComplianceAttachmentAccuracyStatus;
    notes: string[];
  };
  architecturalCompliance: {
    requirementsCompliance: ComplianceRequirementsStatus;
    notesForCheck: ComplianceChecklistRow[];
    violations: string[];
  };
  finalSummary: {
    attachments: string;
    dataConsistency: string;
    architecturalCompliance: string;
    keyIssues: string[];
  };
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
  complianceReport?: ComplianceReport;
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
  projectTypeGroupId?: string;
  projectSubtypeId?: string;
  projectDescription: string;
  selectedDocuments: string[];
  comments: string;
  uploadedAttachments: UploadedAttachment[];
  llmReview?: LlmReview | null;
  review: ReviewResult;
};
