# Riyadh AI License Approval PoC

Standalone website proof of concept for AI-assisted engineering license approvals in Riyadh Municipality.

## What it contains

- Engineering office layer to prepare and submit an application
- Municipality review layer with an AI recommendation, missing-document detection, and workflow timeline
- Policy-driven data model seeded from Arabic regulatory source files now vendored inside the project under `sources/`

## Source coverage

The PoC includes the 12 policy/service types identified in the supplied documents:

1. إصدار رخصة بناء إلكترونية
2. تجديد وتعديل رخصة البناء
3. تصحيح وضع مبنى قائم
4. نقل ملكية
5. إصدار رخصة هدم
6. إصدار رخصة ترميم
7. إصدار رخصة هدم حكومي
8. إصدار رخصة ترميم حكومي
9. إصدار رخصة بناء بالتزامن
10. إصدار رخصة بناء استثماري
11. إصدار رخصة بناء حكومي استثماري
12. رخصة تجهيز الموقع

## Run

```bash
npm install
npm run build:knowledge
npm run dev
```

Then open the local Vite URL printed in the terminal.

- `npm run build:knowledge` regenerates `src/data/policyKnowledgeBase.generated.json` from the vendored source files in `sources/`.
- You only need to rerun it when those source files change.

## Model cost control

The API server supports separate model settings for review and document extraction.

```bash
OPENAI_UI_REVIEW_MODEL=gpt-4o-mini
OPENAI_UI_EXTRACTION_MODEL=gpt-4o-mini
```

- `OPENAI_UI_EXTRACTION_MODEL` is the important one for cost when PDFs are analyzed page by page.
- If these variables are not set, the server now defaults both flows to `gpt-4o-mini`.
- If you want a stronger review model later, keep extraction on a mini model and only raise `OPENAI_UI_REVIEW_MODEL`.

## Production environment

Copy `.env.example` to `.env` and set the values you need.

Key variables:

- `OPENAI_API_KEY`
- `OPENAI_UI_REVIEW_MODEL`
- `OPENAI_UI_EXTRACTION_MODEL`
- `PORT`
- `ALLOWED_ORIGINS` for split frontend/API deployment
- `VITE_API_BASE_URL` only when the frontend is hosted separately from the API

## Deployment

The app can now be deployed in either of these modes:

1. Single service deployment

- Build with `npm run build`
- Start with `npm start`
- The Express server will serve the built Vite frontend from `dist/` and expose the API under `/api`
- Best for internal demos, VPS, Docker, Railway, Render, Fly.io, Azure App Service

2. Split deployment

- Deploy the frontend from `dist/`
- Deploy the API separately with `npm start`
- Set `VITE_API_BASE_URL` on the frontend host to the API URL
- Set `ALLOWED_ORIGINS` on the API host to the frontend origin, for example `https://your-frontend.example.com`

### Docker

Build and run locally:

```bash
docker build -t riyadh-license-ai-poc .
docker run --rm -p 8787:8787 --env-file .env riyadh-license-ai-poc
```

### Railway / Render / Fly.io

- Build command: `npm install && npm run build`
- Start command: `npm start`
- Ensure `OPENAI_API_KEY` is configured
- Optionally set `PORT`, `ALLOWED_ORIGINS`, and model overrides

## AI sheet validation

- The municipality review endpoint now returns per-sheet validation cards and suggested municipal replies generated from the extracted sheet text itself.
- The previous deterministic validation remains as a fallback when the AI response is unavailable.

## Implementation notes

- `src/data/policyData.ts` contains the policy references, required documents, and workflow steps.
- `src/ai/reviewEngine.ts` contains the AI-style rule evaluation used for the PoC.
- `src/App.tsx` renders the two layers and the simulated municipal review queue.
- `server/review-server.mjs` now serves both the API and the built frontend in single-service deployments.
- `sources/` contains the vendored policy and supplemental source files used by the knowledge build.

This remains a PoC. It does not include authentication, backend persistence, or production document storage.
