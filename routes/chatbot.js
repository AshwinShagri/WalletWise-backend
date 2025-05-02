const express = require("express");
const router = express.Router();
const { interactWithChatbot } = require("../controllers/chatbotController");
const authMiddleware = require("../middleware/authMiddleware");

router.post("/interact", authMiddleware, interactWithChatbot);

module.exports = router;