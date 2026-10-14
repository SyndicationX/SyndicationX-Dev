import { Router } from "express";
import { blockCrossOrgColleagueDealMutations } from "../middleware/crossOrgDealManage.middleware.js";
import {
  deleteDealAssetHandler,
  getDealAsset,
  getDealAssets,
  postDealAsset,
  putDealAsset,
  putDealAssets,
} from "../controllers/dealAssets/dealAssets.controller.js";

const router = Router();

router.use("/deals/:dealId", blockCrossOrgColleagueDealMutations);

/** Assets section for a deal (property + additional information). */
router.get("/deals/:dealId/assets", getDealAssets);
router.put("/deals/:dealId/assets", putDealAssets);
router.post("/deals/:dealId/assets", postDealAsset);
router.get("/deals/:dealId/assets/:assetId", getDealAsset);
router.put("/deals/:dealId/assets/:assetId", putDealAsset);
router.delete("/deals/:dealId/assets/:assetId", deleteDealAssetHandler);

export default router;
