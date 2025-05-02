const express = require("express");
const router = express.Router();
const { 
  addManualExpense, 
  getExpenses,
  deleteExpense // Add this import
} = require("../controllers/expenseController");
const authMiddleware = require("../middleware/authMiddleware");

// Protected routes with auth middleware
router.post("/manual", authMiddleware, addManualExpense);
router.get("/list", authMiddleware, getExpenses);
router.delete("/:id", authMiddleware, deleteExpense); // This should now work

module.exports = router;