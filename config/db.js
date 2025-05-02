const admin = require("./firebaseAdmin"); // Ensure this exists and is correctly set up

const db = admin.firestore(); // Initialize Firestore

module.exports = db;
