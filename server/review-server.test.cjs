const request = require("supertest");

function createMockClient() {
  return {
    chat: {
      completions: {
        create: async ({ messages }) => {
          const systemPrompt = String(messages?.[0]?.content || "");
          if (
            systemPrompt.includes("uploaded engineering permit attachments")
          ) {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      confidence: 88,
                      extractedText:
                        "مخطط الأمن والسلامة. مخطط معماري. صورة الصك.",
                      detectedDocuments: [
                        "مخطط الأمن والسلامة",
                        "صورة الصك",
                        "مخطط معماري",
                      ],
                      notes: ["تم الاعتماد على قراءة مرئية للصفحات المرفوعة."],
                    }),
                  },
                },
              ],
            };
          }

          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    decision: "needs-more-info",
                    confidence: 82,
                    summary:
                      "المعاملة تحتاج إلى استكمال بعض المتطلبات قبل التوصية بالاعتماد.",
                    reasoning: [
                      "تم العثور على بعض المستندات، لكن بيانات أساسية ما زالت غير مكتملة.",
                    ],
                    missingItems: ["مخطط الموقع المعتمد"],
                    risks: ["غياب المخطط قد يؤخر المراجعة النظامية."],
                    suggestedActions: [
                      "طلب استكمال المخطط المعتمد من المكتب الهندسي.",
                    ],
                    documentValidations: [
                      {
                        documentName: "المخطط الإنشائي",
                        status: "warning",
                        summary:
                          "تم العثور على اللوحة لكن عناصرها غير كافية للاعتماد النهائي.",
                        details: [
                          "ظهر عنوان إنشائي في الملف.",
                          "لم تظهر بوضوح جميع العناصر الأساسية مثل القواعد والكمرات.",
                        ],
                        evidenceSnippets: [
                          "عنوان اللوحة: مخطط إنشائي للدور الأرضي.",
                          "جدول العناصر يوضح أعمدة وقواعد بشكل جزئي.",
                        ],
                      },
                    ],
                    suggestedResponses: [
                      {
                        actionType: "return-to-reviewer",
                        title: "إعادة للمدقق الإنشائي",
                        text: "يرجى استكمال المخطط الإنشائي بما يوضح العناصر الأساسية قبل إعادة الإرسال.",
                        rationale:
                          "الملف الحالي يحتاج استكمالاً ثم مراجعة تخصصية جديدة.",
                      },
                    ],
                    evidence: [
                      {
                        label: "ملخص السياسة",
                        sourcePath: "/tmp/policy.docx",
                        excerpt: "يجب إرفاق مخطط الموقع المعتمد.",
                        relevance: "النص يوضح المستند المطلوب للمراجعة.",
                      },
                    ],
                  }),
                },
              },
            ],
          };
        },
      },
    },
  };
}

async function createTestApp() {
  const { createReviewApp } = await import("./review-server.mjs");
  return createReviewApp({
    reviewModel: "gpt-test",
    extractionModel: "gpt-test-extract",
    client: createMockClient(),
    knowledgeBase: {
      policies: {
        "building-license": {
          sourcePath: "/tmp/policy.docx",
          summarySnippet: "هذه سياسة تجريبية لاختبار نقطة النهاية.",
          text: "هذه سياسة تجريبية لاختبار نقطة النهاية. يجب إرفاق مخطط الموقع المعتمد. تقوم الامانة بمراجعة الطلب.",
        },
      },
    },
  });
}

describe("review server", () => {
  test("health endpoint reports readiness", async () => {
    const app = await createTestApp();
    const response = await request(app).get("/api/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      model: "gpt-test",
      reviewModel: "gpt-test",
      extractionModel: "gpt-test-extract",
      hasApiKey: true,
    });
  });

  test("llm review endpoint returns structured review payload", async () => {
    const app = await createTestApp();
    const response = await request(app)
      .post("/api/llm-review")
      .send({
        policy: {
          id: "building-license",
          title: "رخصة بناء",
          references: ["لائحة تجريبية"],
          requiredDocuments: ["مخطط الموقع المعتمد", "المخطط الإنشائي"],
          workflow: [
            {
              id: "1",
              actor: "الأمانة",
              action: "مراجعة الطلب",
              duration: "يوم",
              phase: "municipality",
            },
          ],
        },
        submission: {
          applicantName: "شركة الاختبار",
          officeName: "مكتب الاختبار",
          district: "الندى",
          plotNumber: "12/أ",
          projectDescription: "معاملة تجريبية",
          comments: "يرجى التحقق",
          uploadedAttachments: [
            {
              name: "site-plan.pdf",
              sourceType: "pdf",
              detectedDocuments: ["مخطط الموقع المعتمد"],
              notes: [],
              extractedText: "مخطط الموقع المعتمد",
            },
          ],
        },
        ruleReview: {
          matchedDocuments: ["مخطط الموقع المعتمد"],
          missingDocuments: [],
          policyAlerts: [],
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.model).toBe("gpt-test");
    expect(response.body.decision).toBe("needs-more-info");
    expect(response.body.summary).toContain("المعاملة");
    expect(response.body.evidence).toHaveLength(1);
    expect(response.body.evidence[0].sourcePath).toBe("/tmp/policy.docx");
    expect(response.body.documentValidations).toHaveLength(1);
    expect(response.body.documentValidations[0]).toMatchObject({
      documentName: "المخطط الإنشائي",
      status: "warning",
      source: "ai",
      evidenceSnippets: [
        "عنوان اللوحة: مخطط إنشائي للدور الأرضي.",
        "جدول العناصر يوضح أعمدة وقواعد بشكل جزئي.",
      ],
    });
    expect(response.body.suggestedResponses).toEqual([
      {
        actionType: "return-to-reviewer",
        title: "إعادة للمدقق الإنشائي",
        text: "يرجى استكمال المخطط الإنشائي بما يوضح العناصر الأساسية قبل إعادة الإرسال.",
        rationale: "الملف الحالي يحتاج استكمالاً ثم مراجعة تخصصية جديدة.",
        source: "ai",
      },
    ]);
  });

  test("attachment extraction endpoint returns mapped document hints", async () => {
    const app = await createTestApp();
    const response = await request(app)
      .post("/api/extract-attachment")
      .send({
        fileName: "warehouse.pdf",
        mimeType: "application/pdf",
        localExtractedText: "صورة الصك",
        requiredDocuments: [
          "صورة الصك",
          "مخطط الأمن والسلامة",
          "المخططات المعمارية",
        ],
        pageImages: [
          {
            pageNumber: 1,
            dataUrl: "data:image/jpeg;base64,ZmFrZQ==",
          },
        ],
      });

    expect(response.status).toBe(200);
    expect(response.body.model).toBe("gpt-test-extract");
    expect(response.body.detectedDocuments).toEqual([
      "صورة الصك",
      "مخطط الأمن والسلامة",
    ]);
    expect(response.body.extractedText).toContain("مخطط الأمن والسلامة");
  });

  test("llm review endpoint validates required payload", async () => {
    const app = await createTestApp();
    const response = await request(app).post("/api/llm-review").send({});

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Missing policy");
  });

  test("attachment extraction endpoint validates required payload", async () => {
    const app = await createTestApp();
    const response = await request(app)
      .post("/api/extract-attachment")
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Missing fileName");
  });
});
