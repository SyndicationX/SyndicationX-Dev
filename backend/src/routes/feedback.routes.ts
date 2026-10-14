import { Router } from "express";
import {
  getFeedbackCatalogHandler,
  getFeedbackItemHandler,
  getFeedbackListHandler,
  getMyFeedbackAlertsHandler,
  getMyFeedbackHandler,
  getPendingFeedbackCountHandler,
  patchFeedbackHandler,
  patchFeedbackPriorityHandler,
  patchFeedbackTypeHandler,
  postFeedbackHandler,
  postReviewFeedbackHandler,
  putFeedbackCatalogHandler,
} from "../controllers/feedback/feedback.controller.js";

const router = Router();

router.get("/feedback/catalog", getFeedbackCatalogHandler);
router.put("/feedback/catalog", putFeedbackCatalogHandler);
router.get("/feedback/my-alerts", getMyFeedbackAlertsHandler);
router.get("/feedback/pending-count", getPendingFeedbackCountHandler);
router.get("/feedback/mine", getMyFeedbackHandler);
router.get("/feedback/item/:id", getFeedbackItemHandler);
router.get("/feedback", getFeedbackListHandler);
router.post("/feedback", postFeedbackHandler);
router.patch("/feedback/:id/priority", patchFeedbackPriorityHandler);
router.patch("/feedback/:id/type", patchFeedbackTypeHandler);
router.patch("/feedback/:id", patchFeedbackHandler);
router.post("/feedback/:id/review", postReviewFeedbackHandler);

export default router;
