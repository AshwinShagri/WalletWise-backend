const admin = require("firebase-admin");
const db = require("../config/db"); // Firestore instance

// Add Manual Expense
exports.addManualExpense = async (req, res) => {
    try {
        const { title, amount, category, date } = req.body;
        const { uid } = req.user; // Ensure user is authenticated

        if (!title || !amount || !category || !date) {
            return res.status(400).json({ error: "All fields are required" });
        }

        await db.collection("expenses").add({
            title,
            amount,
            category,
            date,
            userId: uid,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        res.status(201).json({ message: "Expense added successfully!" });
    } catch (error) {
        console.error("Error adding expense:", error);
        res.status(500).json({ error: error.message });
    }
};

// Get Expenses List
exports.getExpenses = async (req, res) => {
    try {
        const { uid } = req.user;

        const snapshot = await db.collection("expenses")
            .where("userId", "==", uid)
            .orderBy("createdAt", "desc") // Sort only by creation time
            .get();

        if (snapshot.empty) {
            return res.status(200).json({ expenses: [] });
        }

        const expenses = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
        }));

        res.status(200).json({ expenses });
    } catch (error) {
        console.error("Error fetching expenses:", error);
        res.status(500).json({ error: error.message });
    }
};
// Delete Expense
exports.deleteExpense = async (req, res) => {
    try {
        const { id } = req.params;
        const { uid } = req.user;

        // Verify the expense belongs to the user before deleting
        const expenseRef = db.collection("expenses").doc(id);
        const doc = await expenseRef.get();

        if (!doc.exists) {
            return res.status(404).json({ error: "Expense not found" });
        }

        if (doc.data().userId !== uid) {
            return res.status(403).json({ error: "Unauthorized" });
        }

        await expenseRef.delete();
        res.status(200).json({ message: "Expense deleted successfully" });
    } catch (error) {
        console.error("Error deleting expense:", error);
        res.status(500).json({ error: error.message });
    }
};