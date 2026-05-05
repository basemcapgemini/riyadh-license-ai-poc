import knowledgeBaseJson from "./policyKnowledgeBase.generated.json";

export type PolicyKnowledgeRecord = {
  sourcePath: string;
  sourceFileName: string;
  titleLine: string;
  summarySnippet: string;
  text: string;
};

export type PolicyKnowledgeBase = {
  generatedAt: string;
  sourceRoot: string;
  supplementalIndexPath: string;
  supplementalSources: PolicyKnowledgeRecord[];
  policies: Record<string, PolicyKnowledgeRecord>;
};

export const policyKnowledgeBase = knowledgeBaseJson as PolicyKnowledgeBase;

export function getPolicyKnowledge(
  policyId: string,
): PolicyKnowledgeRecord | null {
  return policyKnowledgeBase.policies[policyId] ?? null;
}
