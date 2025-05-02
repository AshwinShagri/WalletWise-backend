const admin = require("../config/firebaseAdmin"); // Firestore setup
const db = admin.firestore();

const Expense = {
  addManualExpense: async (userId, amount, category, date, title = "") => {
    try {
      const newExpense = {
        userId, // Link expense to the user
        amount,
        category,
        date,
        title,
        createdAt: new Date(),
      };

      const expenseRef = await db.collection("expenses").add(newExpense);
      return { id: expenseRef.id, ...newExpense }; // Return stored data with Firestore ID
    } catch (error) {
      throw new Error("Error adding expense: " + error.message);
    }
  },
};

module.exports = Expense;
