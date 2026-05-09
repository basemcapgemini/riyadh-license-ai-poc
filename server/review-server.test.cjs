const request = require("supertest");

function createMockClient() {
  return {
    chat: {
      completions: {
        create: async ({ messages }) => {
          const systemPrompt = String(messages?.[0]?.content || "");
          if (
            systemPrompt.includes(
              "You validate one uploaded engineering permit attachment",
            )
          ) {
            const userPayload = JSON.parse(
              String(messages?.[1]?.content || "{}"),
            );
            const checklistItems = Array.isArray(
              userPayload?.architecturalChecklistItems,
            )
              ? userPayload.architecturalChecklistItems
              : [];
            const expectedDocument = String(
              userPayload?.file?.expectedDocument || "",
            );

            if (
              expectedDocument.includes("المخططات المعمارية") &&
              checklistItems.length > 0
            ) {
              return {
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        status: "passed",
                        summary:
                          "تم التعرّف على المخططات المعمارية وبدء فحص جميع بنود التدقيق المطلوبة.",
                        feedback: [
                          "الملف مرتبط بالمخططات المعمارية.",
                          "تم توليد نتيجة مستقلة لكل بند في قائمة التدقيق.",
                        ],
                        checklistResults: checklistItems.map((item) => ({
                          item,
                          status:
                            item === "الارتدادات النظامية"
                              ? "Compliant"
                              : "Not Found",
                          comment:
                            item === "الارتدادات النظامية"
                              ? "تظهر الارتدادات النظامية بوضوح في اللوحات المتاحة."
                              : "لم يتم العثور على دليل صريح لهذا البند داخل الملف الحالي.",
                        })),
                        confidence: 91,
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
                      status: "passed",
                      summary: "الملف يطابق المتطلب المطلوب بشكل واضح.",
                      feedback: [
                        "ظهر عنوان المستند المطلوب داخل الملف.",
                        "لا توجد ملاحظات حرجة على هذا الملف في هذه المرحلة.",
                      ],
                      confidence: 91,
                    }),
                  },
                },
              ],
            };
          }

          if (
            systemPrompt.includes(
              "You classify CAD and engineering drawing pages",
            )
          ) {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      pages: [
                        {
                          pageNumber: 1,
                          relevance: "critical",
                          reason: "تظهر بيانات لوحة وعنوان مستند مطلوب بوضوح.",
                          detectedDocuments: ["مخطط الأمن والسلامة"],
                        },
                        {
                          pageNumber: 2,
                          relevance: "ignore",
                          reason:
                            "صفحة منخفضة الإشارة ولا تحمل عنواناً واضحاً.",
                          detectedDocuments: [],
                        },
                      ],
                    }),
                  },
                },
              ],
            };
          }

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

function createRateLimitedValidationClient() {
  return {
    chat: {
      completions: {
        create: async ({ model, messages }) => {
          const systemPrompt = String(messages?.[0]?.content || "");

          if (
            model === "gpt-test-extract" &&
            systemPrompt.includes(
              "You validate one uploaded engineering permit attachment",
            )
          ) {
            const error = new Error(
              "429 Rate limit reached for gpt-4o-mini. Please try again in 1ms.",
            );
            error.status = 429;
            throw error;
          }

          if (
            model === "gpt-test-fallback" &&
            systemPrompt.includes(
              "You validate one uploaded engineering permit attachment",
            )
          ) {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      status: "passed",
                      summary:
                        "تمت إعادة المحاولة بنجاح على النموذج الاحتياطي الأرخص.",
                      feedback: [
                        "تم تجاوز حد المعدل على النموذج الأساسي.",
                        "أعاد النموذج الاحتياطي نتيجة صالحة لهذا الملف.",
                      ],
                      confidence: 84,
                    }),
                  },
                },
              ],
            };
          }

          return createMockClient().chat.completions.create({
            model,
            messages,
          });
        },
      },
    },
  };
}

function createPersistentRateLimitThenFallbackClient() {
  const attemptsByModel = new Map();

  return {
    chat: {
      completions: {
        create: async ({ model, messages }) => {
          const systemPrompt = String(messages?.[0]?.content || "");

          if (
            !systemPrompt.includes(
              "You validate one uploaded engineering permit attachment",
            )
          ) {
            return createMockClient().chat.completions.create({
              model,
              messages,
            });
          }

          const nextAttempt = (attemptsByModel.get(model) || 0) + 1;
          attemptsByModel.set(model, nextAttempt);

          if (model === "gpt-test-extract" && nextAttempt <= 3) {
            const error = new Error(
              `429 Rate limit reached for ${model}. Please try again in 1ms.`,
            );
            error.status = 429;
            throw error;
          }

          if (model === "gpt-test-fallback" && nextAttempt === 1) {
            const error = new Error(
              `429 Rate limit reached for ${model}. Please try again in 1ms.`,
            );
            error.status = 429;
            throw error;
          }

          if (model === "gpt-test-fallback") {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      status: "passed",
                      summary:
                        "استمر الخادم في إعادة المحاولة حتى عاد أحد النماذج برد صالح.",
                      feedback: [
                        "تم تدوير المحاولة بين أكثر من نموذج تلقائياً.",
                        "اكتمل التحقق دون إسقاط الملف من الدفعة.",
                      ],
                      confidence: 79,
                    }),
                  },
                },
              ],
            };
          }

          return createMockClient().chat.completions.create({
            model,
            messages,
          });
        },
      },
    },
  };
}

function createImplicitFallbackClient() {
  return {
    chat: {
      completions: {
        create: async ({ model, messages }) => {
          const systemPrompt = String(messages?.[0]?.content || "");

          if (
            systemPrompt.includes(
              "You validate one uploaded engineering permit attachment",
            ) &&
            model === "gpt-4o-mini"
          ) {
            const error = new Error(
              "429 Rate limit reached for gpt-4o-mini. Please try again in 1ms.",
            );
            error.status = 429;
            throw error;
          }

          if (
            systemPrompt.includes(
              "You validate one uploaded engineering permit attachment",
            ) &&
            model === "gpt-4.1-mini"
          ) {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      status: "passed",
                      summary:
                        "تم تحويل نفس الطلب تلقائياً إلى نموذج بديل بعد حد المعدل.",
                      feedback: [
                        "استقبل النموذج البديل نفس الحمولة دون تعديل.",
                        "اكتمل التحقق بعد تجاوز حد المعدل على النموذج الأساسي.",
                      ],
                      confidence: 83,
                    }),
                  },
                },
              ],
            };
          }

          return createMockClient().chat.completions.create({
            model,
            messages,
          });
        },
      },
    },
  };
}

function createAccessibilityOverclaimClient() {
  return {
    chat: {
      completions: {
        create: async ({ messages }) => {
          const systemPrompt = String(messages?.[0]?.content || "");

          if (
            systemPrompt.includes(
              "You validate one uploaded engineering permit attachment",
            )
          ) {
            const userPayload = JSON.parse(
              String(messages?.[1]?.content || "{}"),
            );
            const checklistItems = Array.isArray(
              userPayload?.architecturalChecklistItems,
            )
              ? userPayload.architecturalChecklistItems
              : [];

            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      status: "passed",
                      summary:
                        "تم التعرّف على المخططات المعمارية وبدء فحص جميع بنود التدقيق المطلوبة.",
                      feedback: [
                        "الملف مرتبط بالمخططات المعمارية.",
                        "تم توليد نتيجة مستقلة لكل بند في قائمة التدقيق.",
                      ],
                      checklistResults: checklistItems.map((item) => ({
                        item,
                        status:
                          item === "متطلبات ذوي الإعاقة (إن وجد)"
                            ? "Compliant"
                            : item === "الارتدادات النظامية"
                              ? "Compliant"
                              : "Not Found",
                        comment:
                          item === "متطلبات ذوي الإعاقة (إن وجد)"
                            ? "ادعى النموذج وجود متطلبات لذوي الإعاقة دون دليل صريح."
                            : item === "الارتدادات النظامية"
                              ? "تظهر الارتدادات النظامية بوضوح في اللوحات المتاحة."
                              : "لم يتم العثور على دليل صريح لهذا البند داخل الملف الحالي.",
                      })),
                      confidence: 88,
                    }),
                  },
                },
              ],
            };
          }

          return createMockClient().chat.completions.create({ messages });
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
    fallbackModel: "gpt-test-fallback",
    cadClassifierModel: "gpt-test-classifier",
    cadCriticalModel: "gpt-test-critical",
    client: createMockClient(),
    notesForCheckContext: {
      sourcePath: "/tmp/notes-for-check.xlsx",
      fileName: "notes-for-check.xlsx",
      checklistItems: [
        {
          sheetName: "Checklist",
          rowNumber: 1,
          section: "تدقيق معماري",
          kind: "architectural",
          text: "الارتدادات النظامية",
        },
        {
          sheetName: "Checklist",
          rowNumber: 2,
          section: "تدقيق معماري",
          kind: "architectural",
          text: "نسبة البناء",
        },
        {
          sheetName: "Checklist",
          rowNumber: 3,
          section: "تدقيق معماري",
          kind: "architectural",
          text: "مواقف السيارات",
        },
        {
          sheetName: "Checklist",
          rowNumber: 4,
          section: "تدقيق معماري",
          kind: "architectural",
          text: "متطلبات ذوي الإعاقة (إن وجد)",
        },
        {
          sheetName: "Checklist",
          rowNumber: 5,
          section: "تدقيق معماري",
          kind: "architectural",
          text: "عدد الأدوار والارتفاع",
        },
        {
          sheetName: "Checklist",
          rowNumber: 8,
          section: "مطابقات",
          kind: "consistency",
          text: "مطابقة الاستخدام بين (الصك . الرخصة السابقة . نظام البناء)",
        },
        {
          sheetName: "Checklist",
          rowNumber: 9,
          section: "مطابقات",
          kind: "consistency",
          text: "مطابقة المساحات بين ( التقرير الفني . المخطط المعماري .النظام الإلكتروني)",
        },
      ],
    },
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

async function createRateLimitedValidationTestApp() {
  const { createReviewApp } = await import("./review-server.mjs");
  return createReviewApp({
    reviewModel: "gpt-test",
    extractionModel: "gpt-test-extract",
    fallbackModel: "gpt-test-fallback",
    fallbackModels: ["gpt-test-fallback"],
    cadClassifierModel: "gpt-test-classifier",
    cadCriticalModel: "gpt-test-critical",
    client: createRateLimitedValidationClient(),
    notesForCheckContext: {
      sourcePath: "/tmp/notes-for-check.xlsx",
      fileName: "notes-for-check.xlsx",
      checklistItems: [],
    },
    knowledgeBase: {
      policies: {
        "building-license": {
          sourcePath: "/tmp/policy.docx",
          summarySnippet: "هذه سياسة تجريبية لاختبار نقطة النهاية.",
          text: "هذه سياسة تجريبية لاختبار نقطة النهاية.",
        },
      },
    },
  });
}

async function createPersistentRateLimitFallbackTestApp() {
  const { createReviewApp } = await import("./review-server.mjs");
  return createReviewApp({
    reviewModel: "gpt-test",
    extractionModel: "gpt-test-extract",
    fallbackModels: ["gpt-test-fallback", "gpt-test-review-backup"],
    cadClassifierModel: "gpt-test-classifier",
    cadCriticalModel: "gpt-test-critical",
    client: createPersistentRateLimitThenFallbackClient(),
    notesForCheckContext: {
      sourcePath: "/tmp/notes-for-check.xlsx",
      fileName: "notes-for-check.xlsx",
      checklistItems: [],
    },
    knowledgeBase: {
      policies: {
        "building-license": {
          sourcePath: "/tmp/policy.docx",
          summarySnippet: "هذه سياسة تجريبية لاختبار نقطة النهاية.",
          text: "هذه سياسة تجريبية لاختبار نقطة النهاية.",
        },
      },
    },
  });
}

async function createImplicitFallbackTestApp() {
  const { createReviewApp } = await import("./review-server.mjs");
  return createReviewApp({
    reviewModel: "gpt-4o-mini",
    extractionModel: "gpt-4o-mini",
    fallbackModel: "",
    fallbackModels: [],
    cadClassifierModel: "gpt-test-classifier",
    cadCriticalModel: "gpt-test-critical",
    client: createImplicitFallbackClient(),
    notesForCheckContext: {
      sourcePath: "/tmp/notes-for-check.xlsx",
      fileName: "notes-for-check.xlsx",
      checklistItems: [],
    },
    knowledgeBase: {
      policies: {
        "building-license": {
          sourcePath: "/tmp/policy.docx",
          summarySnippet: "هذه سياسة تجريبية لاختبار نقطة النهاية.",
          text: "هذه سياسة تجريبية لاختبار نقطة النهاية.",
        },
      },
    },
  });
}

async function createDynamicRoutingKnownModelsApp() {
  const { createReviewApp } = await import("./review-server.mjs");
  return createReviewApp({
    reviewModel: "gpt-4.1-nano",
    extractionModel: "gpt-4o-mini",
    cadClassifierModel: "gpt-4.1-mini",
    cadCriticalModel: "gpt-5-mini",
    fallbackModels: ["gpt-4.1-mini", "gpt-4o-mini"],
    client: createMockClient(),
    notesForCheckContext: {
      sourcePath: "/tmp/notes-for-check.xlsx",
      fileName: "notes-for-check.xlsx",
      checklistItems: [],
    },
    knowledgeBase: {
      policies: {
        "building-license": {
          sourcePath: "/tmp/policy.docx",
          summarySnippet: "هذه سياسة تجريبية لاختبار نقطة النهاية.",
          text: "هذه سياسة تجريبية لاختبار نقطة النهاية.",
        },
      },
    },
  });
}

async function createAccessibilityOverclaimTestApp() {
  const { createReviewApp } = await import("./review-server.mjs");
  return createReviewApp({
    reviewModel: "gpt-test",
    extractionModel: "gpt-test-extract",
    fallbackModel: "gpt-test-fallback",
    cadClassifierModel: "gpt-test-classifier",
    cadCriticalModel: "gpt-test-critical",
    client: createAccessibilityOverclaimClient(),
    notesForCheckContext: {
      sourcePath: "/tmp/notes-for-check.xlsx",
      fileName: "notes-for-check.xlsx",
      checklistItems: [
        {
          sheetName: "Checklist",
          rowNumber: 1,
          section: "تدقيق معماري",
          kind: "architectural",
          text: "الارتدادات النظامية",
        },
        {
          sheetName: "Checklist",
          rowNumber: 2,
          section: "تدقيق معماري",
          kind: "architectural",
          text: "نسبة البناء",
        },
        {
          sheetName: "Checklist",
          rowNumber: 3,
          section: "تدقيق معماري",
          kind: "architectural",
          text: "مواقف السيارات",
        },
        {
          sheetName: "Checklist",
          rowNumber: 4,
          section: "تدقيق معماري",
          kind: "architectural",
          text: "متطلبات ذوي الإعاقة (إن وجد)",
        },
        {
          sheetName: "Checklist",
          rowNumber: 5,
          section: "تدقيق معماري",
          kind: "architectural",
          text: "عدد الأدوار والارتفاع",
        },
      ],
    },
    knowledgeBase: {
      policies: {
        "building-license": {
          sourcePath: "/tmp/policy.docx",
          summarySnippet: "هذه سياسة تجريبية لاختبار نقطة النهاية.",
          text: "هذه سياسة تجريبية لاختبار نقطة النهاية.",
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
    expect(response.body.complianceReport).toMatchObject({
      projectInformation: {
        projectType: expect.any(String),
        confidenceLevel: expect.any(String),
      },
      attachmentsStatus: {
        overallStatus: expect.any(String),
        rows: expect.any(Array),
      },
      dataConsistencyCheck: expect.any(Array),
      attachmentAccuracy: {
        status: expect.any(String),
        notes: expect.any(Array),
      },
      architecturalCompliance: {
        requirementsCompliance: expect.any(String),
        notesForCheck: expect.any(Array),
        violations: expect.any(Array),
      },
      finalSummary: {
        attachments: expect.any(String),
        dataConsistency: expect.any(String),
        architecturalCompliance: expect.any(String),
        keyIssues: expect.any(Array),
      },
    });
    expect(response.body.complianceReport.attachmentsStatus.rows).toEqual([
      {
        attachment: "مخطط الموقع المعتمد",
        status: "Present",
        notes: "تم رصد هذا المرفق ضمن الملفات المرفوعة.",
        sourceRefs: [],
      },
      {
        attachment: "المخطط الإنشائي",
        status: "Missing",
        notes: "هذا المرفق مفقود ويجب استكماله.",
        sourceRefs: [],
      },
    ]);
    expect(response.body.complianceReport.dataConsistencyCheck).toHaveLength(7);
    expect(
      response.body.complianceReport.dataConsistencyCheck.map(
        (row) => row.field,
      ),
    ).toEqual([
      "Plot Number",
      "Beneficiary Name",
      "Engineering Office",
      "Plan Number",
      "Deed Number",
      "مطابقة الاستخدام بين (الصك . الرخصة السابقة . نظام البناء)",
      "مطابقة المساحات بين ( التقرير الفني . المخطط المعماري .النظام الإلكتروني)",
    ]);
    expect(
      response.body.complianceReport.architecturalCompliance.notesForCheck,
    ).toHaveLength(5);
    expect(
      response.body.complianceReport.architecturalCompliance.notesForCheck,
    ).toEqual([
      {
        item: "الارتدادات النظامية",
        status: "Not Found",
        comment: "لم يتم العثور على دليل صريح لهذا البند داخل الملفات الحالية.",
        sourceRefs: ["/tmp/notes-for-check.xlsx"],
      },
      {
        item: "نسبة البناء",
        status: "Not Found",
        comment: "لم يتم العثور على دليل صريح لهذا البند داخل الملفات الحالية.",
        sourceRefs: ["/tmp/notes-for-check.xlsx"],
      },
      {
        item: "مواقف السيارات",
        status: "Not Found",
        comment: "لم يتم العثور على دليل صريح لهذا البند داخل الملفات الحالية.",
        sourceRefs: ["/tmp/notes-for-check.xlsx"],
      },
      {
        item: "متطلبات ذوي الإعاقة (إن وجد)",
        status: "Not Found",
        comment: "لم يتم العثور على دليل صريح لهذا البند داخل الملفات الحالية.",
        sourceRefs: ["/tmp/notes-for-check.xlsx"],
      },
      {
        item: "عدد الأدوار والارتفاع",
        status: "Not Found",
        comment: "لم يتم العثور على دليل صريح لهذا البند داخل الملفات الحالية.",
        sourceRefs: ["/tmp/notes-for-check.xlsx"],
      },
    ]);
    expect(response.body.complianceReport.finalSummary.attachments).toBe(
      "مفقود (المخطط الإنشائي)",
    );
    expect(
      response.body.complianceReport.finalSummary.architecturalCompliance,
    ).toBe("غير متوافق");
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

  test("attachment validation endpoint returns file-level ai feedback", async () => {
    const app = await createTestApp();
    const response = await request(app)
      .post("/api/validate-attachment")
      .send({
        fileName: "sak.pdf",
        mimeType: "application/pdf",
        sourceType: "pdf",
        requiredDocuments: ["صورة الصك"],
        expectedDocument: "صورة الصك",
        extractedText: "عنوان المستند: صورة الصك",
        detectedDocuments: ["صورة الصك"],
        notes: ["تم التعرف على عنوان المستند."],
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      model: "gpt-test-extract",
      status: "passed",
      summary: "الملف يطابق المتطلب المطلوب بشكل واضح.",
      feedback: [
        "ظهر عنوان المستند المطلوب داخل الملف.",
        "لا توجد ملاحظات حرجة على هذا الملف في هذه المرحلة.",
      ],
      confidence: 91,
    });
  });

  test("architectural attachment validation returns every workbook checklist point", async () => {
    const app = await createTestApp();
    const response = await request(app)
      .post("/api/validate-attachment")
      .send({
        fileName: "architectural-plans.pdf",
        mimeType: "application/pdf",
        sourceType: "pdf",
        requiredDocuments: ["المخططات المعمارية"],
        expectedDocument: "المخططات المعمارية",
        extractedText: "لوحة معمارية توضح الارتدادات والواجهات وبعض الأبعاد.",
        detectedDocuments: ["المخططات المعمارية"],
        notes: ["تم التعرف على عنوان المخطط المعماري."],
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      model: "gpt-test-extract",
      status: "passed",
      summary:
        "تم التعرّف على المخططات المعمارية وبدء فحص جميع بنود التدقيق المطلوبة.",
      feedback: [
        "الملف مرتبط بالمخططات المعمارية.",
        "تم توليد نتيجة مستقلة لكل بند في قائمة التدقيق.",
      ],
      checklistResults: [
        {
          item: "الارتدادات النظامية",
          status: "Compliant",
          comment: "تظهر الارتدادات النظامية بوضوح في اللوحات المتاحة.",
        },
        {
          item: "نسبة البناء",
          status: "Not Found",
          comment: "لم يتم العثور على دليل صريح لهذا البند داخل الملف الحالي.",
        },
        {
          item: "مواقف السيارات",
          status: "Not Found",
          comment: "لم يتم العثور على دليل صريح لهذا البند داخل الملف الحالي.",
        },
        {
          item: "متطلبات ذوي الإعاقة (إن وجد)",
          status: "Not Found",
          comment: "لم يتم العثور على دليل صريح لهذا البند داخل الملف الحالي.",
        },
        {
          item: "عدد الأدوار والارتفاع",
          status: "Not Found",
          comment: "لم يتم العثور على دليل صريح لهذا البند داخل الملف الحالي.",
        },
      ],
      confidence: 91,
    });
  });

  test("architectural attachment validation also works for numbered document labels", async () => {
    const app = await createTestApp();
    const response = await request(app)
      .post("/api/validate-attachment")
      .send({
        fileName: "architectural-plans.pdf",
        mimeType: "application/pdf",
        sourceType: "pdf",
        requiredDocuments: ["48 - المخططات المعمارية"],
        expectedDocument: "48 - المخططات المعمارية",
        extractedText: "لوحة معمارية توضح الارتدادات والواجهات وبعض الأبعاد.",
        detectedDocuments: ["48 - المخططات المعمارية"],
        notes: ["تم التعرف على عنوان المخطط المعماري."],
      });

    expect(response.status).toBe(200);
    expect(response.body.checklistResults).toEqual([
      {
        item: "الارتدادات النظامية",
        status: "Compliant",
        comment: "تظهر الارتدادات النظامية بوضوح في اللوحات المتاحة.",
      },
      {
        item: "نسبة البناء",
        status: "Not Found",
        comment: "لم يتم العثور على دليل صريح لهذا البند داخل الملف الحالي.",
      },
      {
        item: "مواقف السيارات",
        status: "Not Found",
        comment: "لم يتم العثور على دليل صريح لهذا البند داخل الملف الحالي.",
      },
      {
        item: "متطلبات ذوي الإعاقة (إن وجد)",
        status: "Not Found",
        comment: "لم يتم العثور على دليل صريح لهذا البند داخل الملف الحالي.",
      },
      {
        item: "عدد الأدوار والارتفاع",
        status: "Not Found",
        comment: "لم يتم العثور على دليل صريح لهذا البند داخل الملف الحالي.",
      },
    ]);
  });

  test("architectural attachment validation treats جدول المساحات as building-ratio evidence", async () => {
    const app = await createTestApp();
    const response = await request(app)
      .post("/api/validate-attachment")
      .send({
        fileName: "architectural-plans.pdf",
        mimeType: "application/pdf",
        sourceType: "pdf",
        requiredDocuments: ["48 - المخططات المعمارية"],
        expectedDocument: "48 - المخططات المعمارية",
        extractedText:
          "لوحة معمارية تحتوي على جدول المساحات وتفاصيل المسطحات للدور الأرضي والأول.",
        detectedDocuments: ["48 - المخططات المعمارية"],
        notes: ["تم التعرف على عنوان المخطط المعماري وجدول المساحات."],
      });

    expect(response.status).toBe(200);
    expect(response.body.checklistResults).toEqual([
      {
        item: "الارتدادات النظامية",
        status: "Compliant",
        comment: "تظهر الارتدادات النظامية بوضوح في اللوحات المتاحة.",
      },
      {
        item: "نسبة البناء",
        status: "Compliant",
        comment:
          "تم رصد جدول المساحات ويُستخدم كمرجع مباشر للتحقق من نسبة البناء في الملف أو الملفات الحالية.",
      },
      {
        item: "مواقف السيارات",
        status: "Not Found",
        comment: "لم يتم العثور على دليل صريح لهذا البند داخل الملف الحالي.",
      },
      {
        item: "متطلبات ذوي الإعاقة (إن وجد)",
        status: "Not Found",
        comment: "لم يتم العثور على دليل صريح لهذا البند داخل الملف الحالي.",
      },
      {
        item: "عدد الأدوار والارتفاع",
        status: "Not Found",
        comment: "لم يتم العثور على دليل صريح لهذا البند داخل الملف الحالي.",
      },
    ]);
  });

  test("architectural attachment validation treats visual parking layout as parking evidence", async () => {
    const app = await createTestApp();
    const response = await request(app)
      .post("/api/validate-attachment")
      .send({
        fileName: "architectural-plans.pdf",
        mimeType: "application/pdf",
        sourceType: "pdf",
        requiredDocuments: ["48 - المخططات المعمارية"],
        expectedDocument: "48 - المخططات المعمارية",
        extractedText:
          "لوحة معمارية توضح صف مواقف سيارات مرسوم عند الواجهة الجانبية مع مدخل سيارة ومنحدر وصول.",
        detectedDocuments: ["48 - المخططات المعمارية"],
        notes: [
          "تظهر مواقف سيارات مرسومة بصرياً داخل المخطط بدون عنوان مستقل.",
        ],
      });

    expect(response.status).toBe(200);
    expect(response.body.checklistResults).toEqual([
      {
        item: "الارتدادات النظامية",
        status: "Compliant",
        comment: "تظهر الارتدادات النظامية بوضوح في اللوحات المتاحة.",
      },
      {
        item: "نسبة البناء",
        status: "Not Found",
        comment: "لم يتم العثور على دليل صريح لهذا البند داخل الملف الحالي.",
      },
      {
        item: "مواقف السيارات",
        status: "Compliant",
        comment:
          "تم رصد توزيع أو رموز مواقف سيارات داخل المخطط ويُعتمد ذلك كدليل على تحقق بند مواقف السيارات حتى لو لم يظهر العنوان نصاً.",
      },
      {
        item: "متطلبات ذوي الإعاقة (إن وجد)",
        status: "Not Found",
        comment: "لم يتم العثور على دليل صريح لهذا البند داخل الملف الحالي.",
      },
      {
        item: "عدد الأدوار والارتفاع",
        status: "Not Found",
        comment: "لم يتم العثور على دليل صريح لهذا البند داخل الملف الحالي.",
      },
    ]);
  });

  test("architectural attachment validation mentions accessibility only when explicitly shown", async () => {
    const app = await createTestApp();
    const response = await request(app)
      .post("/api/validate-attachment")
      .send({
        fileName: "architectural-plans.pdf",
        mimeType: "application/pdf",
        sourceType: "pdf",
        requiredDocuments: ["48 - المخططات المعمارية"],
        expectedDocument: "48 - المخططات المعمارية",
        extractedText:
          "لوحة معمارية توضح منحدر ذوي الإعاقة ومسار كرسي متحرك ودورة مياه مخصصة بجانب المدخل الرئيسي.",
        detectedDocuments: ["48 - المخططات المعمارية"],
        notes: ["تظهر متطلبات ذوي الإعاقة بوضوح داخل المخطط."],
      });

    expect(response.status).toBe(200);
    expect(response.body.checklistResults).toEqual([
      {
        item: "الارتدادات النظامية",
        status: "Compliant",
        comment: "تظهر الارتدادات النظامية بوضوح في اللوحات المتاحة.",
      },
      {
        item: "نسبة البناء",
        status: "Not Found",
        comment: "لم يتم العثور على دليل صريح لهذا البند داخل الملف الحالي.",
      },
      {
        item: "مواقف السيارات",
        status: "Not Found",
        comment: "لم يتم العثور على دليل صريح لهذا البند داخل الملف الحالي.",
      },
      {
        item: "متطلبات ذوي الإعاقة (إن وجد)",
        status: "Compliant",
        comment:
          "تم رصد متطلبات واضحة لذوي الإعاقة داخل المخطط، لذلك يمكن ذكر هذا البند لأنه ظاهر في الملف الحالي.",
      },
      {
        item: "عدد الأدوار والارتفاع",
        status: "Not Found",
        comment: "لم يتم العثور على دليل صريح لهذا البند داخل الملف الحالي.",
      },
    ]);
  });

  test("architectural attachment validation suppresses unsupported accessibility mentions", async () => {
    const app = await createAccessibilityOverclaimTestApp();
    const response = await request(app)
      .post("/api/validate-attachment")
      .send({
        fileName: "architectural-plans.pdf",
        mimeType: "application/pdf",
        sourceType: "pdf",
        requiredDocuments: ["48 - المخططات المعمارية"],
        expectedDocument: "48 - المخططات المعمارية",
        extractedText: "لوحة معمارية توضح الارتدادات والواجهات وبعض الأبعاد.",
        detectedDocuments: ["48 - المخططات المعمارية"],
        notes: ["تم التعرف على عنوان المخطط المعماري."],
      });

    expect(response.status).toBe(200);
    expect(response.body.checklistResults).toEqual([
      {
        item: "الارتدادات النظامية",
        status: "Compliant",
        comment: "تظهر الارتدادات النظامية بوضوح في اللوحات المتاحة.",
      },
      {
        item: "نسبة البناء",
        status: "Not Found",
        comment: "لم يتم العثور على دليل صريح لهذا البند داخل الملف الحالي.",
      },
      {
        item: "مواقف السيارات",
        status: "Not Found",
        comment: "لم يتم العثور على دليل صريح لهذا البند داخل الملف الحالي.",
      },
      {
        item: "متطلبات ذوي الإعاقة (إن وجد)",
        status: "Not Found",
        comment: "لا يتم ذكر هذا البند إلا إذا ظهر صراحة داخل الملف الحالي.",
      },
      {
        item: "عدد الأدوار والارتفاع",
        status: "Not Found",
        comment: "لم يتم العثور على دليل صريح لهذا البند داخل الملف الحالي.",
      },
    ]);
  });

  test("attachment validation retries on 429 and falls back to the cheaper model", async () => {
    const app = await createRateLimitedValidationTestApp();
    const response = await request(app)
      .post("/api/validate-attachment")
      .send({
        fileName: "sak.pdf",
        mimeType: "application/pdf",
        sourceType: "pdf",
        requiredDocuments: ["صورة الصك"],
        expectedDocument: "صورة الصك",
        extractedText: "عنوان المستند: صورة الصك",
        detectedDocuments: ["صورة الصك"],
        notes: ["تم التعرف على عنوان المستند."],
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      model: "gpt-test-fallback",
      status: "passed",
      summary: "تمت إعادة المحاولة بنجاح على النموذج الاحتياطي الأرخص.",
      feedback: [
        "تم تجاوز حد المعدل على النموذج الأساسي.",
        "أعاد النموذج الاحتياطي نتيجة صالحة لهذا الملف.",
      ],
      confidence: 84,
    });
  });

  test("attachment validation keeps retrying across models until one succeeds", async () => {
    const app = await createPersistentRateLimitFallbackTestApp();
    const response = await request(app)
      .post("/api/validate-attachment")
      .send({
        fileName: "sak.pdf",
        mimeType: "application/pdf",
        sourceType: "pdf",
        requiredDocuments: ["صورة الصك"],
        expectedDocument: "صورة الصك",
        extractedText: "عنوان المستند: صورة الصك",
        detectedDocuments: ["صورة الصك"],
        notes: ["تم التعرف على عنوان المستند."],
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      model: "gpt-test-review-backup",
      status: "passed",
      summary: "الملف يطابق المتطلب المطلوب بشكل واضح.",
      feedback: [
        "ظهر عنوان المستند المطلوب داخل الملف.",
        "لا توجد ملاحظات حرجة على هذا الملف في هذه المرحلة.",
      ],
      confidence: 91,
    });
  });

  test("attachment validation automatically switches to another model on 429 when no fallback is configured", async () => {
    const app = await createImplicitFallbackTestApp();
    const response = await request(app)
      .post("/api/validate-attachment")
      .send({
        fileName: "sak.pdf",
        mimeType: "application/pdf",
        sourceType: "pdf",
        requiredDocuments: ["صورة الصك"],
        expectedDocument: "صورة الصك",
        extractedText: "عنوان المستند: صورة الصك",
        detectedDocuments: ["صورة الصك"],
        notes: ["تم التعرف على عنوان المستند."],
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      model: "gpt-4.1-mini",
      status: "passed",
      summary: "تم تحويل نفس الطلب تلقائياً إلى نموذج بديل بعد حد المعدل.",
      feedback: [
        "استقبل النموذج البديل نفس الحمولة دون تعديل.",
        "اكتمل التحقق بعد تجاوز حد المعدل على النموذج الأساسي.",
      ],
      confidence: 83,
    });
  });

  test("attachment validation chooses the cheapest compatible text model for the upload task", async () => {
    const app = await createDynamicRoutingKnownModelsApp();
    const response = await request(app)
      .post("/api/validate-attachment")
      .send({
        fileName: "sak.pdf",
        mimeType: "application/pdf",
        sourceType: "pdf",
        requiredDocuments: ["صورة الصك"],
        expectedDocument: "صورة الصك",
        extractedText: "عنوان المستند: صورة الصك",
        detectedDocuments: ["صورة الصك"],
        notes: ["تم التعرف على عنوان المستند."],
      });

    expect(response.status).toBe(200);
    expect(response.body.model).toBe("gpt-4.1-nano");
  });

  test("standard attachment extraction chooses the cheapest compatible vision model", async () => {
    const app = await createDynamicRoutingKnownModelsApp();
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
        extractionMode: "standard",
        pageImages: [
          {
            pageNumber: 1,
            dataUrl: "data:image/jpeg;base64,ZmFrZQ==",
          },
        ],
      });

    expect(response.status).toBe(200);
    expect(response.body.model).toBe("gpt-4.1-nano");
  });

  test("cad-critical extraction keeps the stronger primary model before falling back", async () => {
    const app = await createDynamicRoutingKnownModelsApp();
    const response = await request(app)
      .post("/api/extract-attachment")
      .send({
        fileName: "warehouse-cad.pdf",
        mimeType: "application/pdf",
        localExtractedText: "مخطط الأمن والسلامة",
        requiredDocuments: ["مخطط الأمن والسلامة", "المخططات المعمارية"],
        extractionMode: "cad-critical",
        pageImages: [
          {
            pageNumber: 1,
            dataUrl: "data:image/jpeg;base64,ZmFrZQ==",
          },
        ],
      });

    expect(response.status).toBe(200);
    expect(response.body.model).toBe("gpt-5-mini");
  });

  test("cad page classification endpoint returns page triage", async () => {
    const app = await createTestApp();
    const response = await request(app)
      .post("/api/classify-cad-pages")
      .send({
        fileName: "warehouse-cad.pdf",
        mimeType: "application/pdf",
        requiredDocuments: ["مخطط الأمن والسلامة", "المخططات المعمارية"],
        localPageTexts: [
          { pageNumber: 1, text: "عنوان لوحة الأمن والسلامة" },
          { pageNumber: 2, text: "" },
        ],
        pageImages: [
          {
            pageNumber: 1,
            dataUrl: "data:image/jpeg;base64,ZmFrZQ==",
          },
          {
            pageNumber: 2,
            dataUrl: "data:image/jpeg;base64,ZmFrZQ==",
          },
        ],
      });

    expect(response.status).toBe(200);
    expect(response.body.model).toBe("gpt-test-classifier");
    expect(response.body.pages).toEqual([
      {
        pageNumber: 1,
        relevance: "critical",
        reason: "تظهر بيانات لوحة وعنوان مستند مطلوب بوضوح.",
        detectedDocuments: ["مخطط الأمن والسلامة"],
      },
      {
        pageNumber: 2,
        relevance: "ignore",
        reason: "صفحة منخفضة الإشارة ولا تحمل عنواناً واضحاً.",
        detectedDocuments: [],
      },
    ]);
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

  test("createReviewApp rejects incompatible models at startup", async () => {
    const { createReviewApp } = await import("./review-server.mjs");

    expect(() =>
      createReviewApp({
        reviewModel: "gpt-image-2",
        extractionModel: "gpt-4.1-mini",
        cadClassifierModel: "gpt-4.1-mini",
        cadCriticalModel: "gpt-4.1-mini",
        client: createMockClient(),
        notesForCheckContext: {
          sourcePath: "/tmp/notes-for-check.xlsx",
          fileName: "notes-for-check.xlsx",
          checklistItems: [],
        },
        knowledgeBase: {
          policies: {
            "building-license": {
              sourcePath: "/tmp/policy.docx",
              summarySnippet: "هذه سياسة تجريبية لاختبار نقطة النهاية.",
              text: "هذه سياسة تجريبية لاختبار نقطة النهاية.",
            },
          },
        },
      }),
    ).toThrow(/reviewModel=gpt-image-2/);
  });
});
