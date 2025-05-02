const express = require("express");
const router = express.Router();
const db = require("../config/db");
const analyticsController = require("../controllers/analyticsController");
const authMiddleware = require("../middleware/authMiddleware");

// Apply auth middleware to all routes
router.use(authMiddleware);

// GET /api/analytics - Get expense analytics
router.get("/", analyticsController.getAnalytics);


module.exports = router;