const admin = require("../config/firebaseAdmin");

const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Unauthorized - No token provided" });
    }

    const token = authHeader.split(" ")[1];
    
    // Log token for debugging (remove in production)
    console.log("Token received:", token.substring(0, 10) + "...");
    
    try {
      const decodedToken = await admin.auth().verifyIdToken(token);
      req.user = decodedToken; // Store user data
      next(); // Proceed to next middleware
    } catch (verifyError) {
      console.error("Token verification failed:", verifyError);
      return res.status(403).json({ error: "Invalid or expired token" });
    }
  } catch (error) {
    console.error("Auth middleware error:", error);
    res.status(500).json({ error: "Server authentication error" });
  }
};

module.exports = authMiddleware;