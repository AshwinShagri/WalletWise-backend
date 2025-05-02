require('dotenv').config()
const express = require("express");
 const cors = require("cors");
 const expenseRoutes = require("./routes/expense");
 const authRoutes = require("./routes/auth");
 const ocrRoutes = require("./routes/ocr");
 const chatbotRoutes = require("./routes/chatbot");
 const analyticsRoutes = require('./routes/analyticsRoutes');
   // Ensure correct path

 const app = express();
 app.use(cors());
 app.use(express.json());

 app.use("/api/auth", authRoutes);
 app.use("/api/expense", expenseRoutes);
 app.use("/api/ocr", ocrRoutes);
 app.use("/api/chatbot", chatbotRoutes);
 app.use('/api/analytics', analyticsRoutes); // Use OCR routes

 const PORT = process.env.PORT || 5000;
 app.listen(PORT, () => console.log(`Server running on port ${PORT}`));