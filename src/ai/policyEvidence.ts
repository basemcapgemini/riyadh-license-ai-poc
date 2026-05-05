import type { EvidenceCitation, LicensePolicy } from "../types";
import { getPolicyKnowledge } from "../data/policyKnowledgeBase";
import { extractSnippet, getSearchTerms } from "./policySearch";

function isEvidenceCitation(
  value: EvidenceCitation | null,
): value is EvidenceCitation {
  return value !== null;
}

function buildCitationId(
  policyId: string,
  category: EvidenceCitation["category"],
  label: string,
): string {
  return `${policyId}-${category}-${label}`;
}

export function buildPolicyEvidence(policy: LicensePolicy): EvidenceCitation[] {
  const knowledge = getPolicyKnowledge(policy.id);
  if (!knowledge) {
    return [];
  }

  return [
    {
      id: buildCitationId(policy.id, "policy", policy.title),
      category: "policy",
      label: policy.title,
      matchedText: knowledge.titleLine,
      sourcePath: knowledge.sourcePath,
      sourceFileName: knowledge.sourceFileName,
      excerpt: knowledge.summarySnippet,
    },
  ];
}

export function buildDocumentEvidence(
  policy: LicensePolicy,
  documentNames: string[],
): EvidenceCitation[] {
  const knowledge = getPolicyKnowledge(policy.id);
  if (!knowledge) {
    return [];
  }

  const citations: Array<EvidenceCitation | null> = documentNames.map(
    (documentName) => {
      const match = extractSnippet(
        knowledge.text,
        getSearchTerms(documentName),
      );
      if (!match) {
        return null;
      }
      return {
        id: buildCitationId(policy.id, "required-document", documentName),
        category: "required-document",
        label: documentName,
        matchedText: match.matchedText,
        sourcePath: knowledge.sourcePath,
        sourceFileName: knowledge.sourceFileName,
        excerpt: match.excerpt,
      } satisfies EvidenceCitation;
    },
  );

  return citations.filter(isEvidenceCitation);
}

export function buildWorkflowEvidence(
  policy: LicensePolicy,
): EvidenceCitation[] {
  const knowledge = getPolicyKnowledge(policy.id);
  if (!knowledge) {
    return [];
  }

  const citations: Array<EvidenceCitation | null> = policy.workflow.map(
    (step) => {
      const searchTerms = [
        step.action,
        `${step.actor} ${step.action}`,
        step.actor,
      ];
      const match = extractSnippet(knowledge.text, searchTerms);
      if (!match) {
        return null;
      }
      return {
        id: buildCitationId(policy.id, "workflow", step.id),
        category: "workflow",
        label: `${step.actor}: ${step.action}`,
        matchedText: match.matchedText,
        sourcePath: knowledge.sourcePath,
        sourceFileName: knowledge.sourceFileName,
        excerpt: match.excerpt,
      } satisfies EvidenceCitation;
    },
  );

  return citations.filter(isEvidenceCitation);
}
