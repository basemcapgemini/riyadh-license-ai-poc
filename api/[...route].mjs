import { createReviewApp } from "../server/review-server.mjs";

const app = createReviewApp();

export default function handler(req, res) {
  return app(req, res);
}
