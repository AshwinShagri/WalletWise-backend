// routes/ocr.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { processReceipt, addExpense } = require('../controllers/ocrController');
const authMiddleware = require('../middleware/authMiddleware');

// Configure multer for memory storage
const storage = multer.memoryStorage();
const upload = multer({ 
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    // Accept images only
    if (!file.originalname.match(/\.(jpg|jpeg|png|gif|webp)$/)) {
      return cb(new Error('Only image files are allowed!'), false);
    }
    cb(null, true);
  }
});

// Route to process receipt using OCR
router.post('/process', authMiddleware, upload.single('receipt'), processReceipt);

// Route to add expense after user confirms details
router.post('/add-expense', authMiddleware, addExpense);

module.exports = router;