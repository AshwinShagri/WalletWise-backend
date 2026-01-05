const db = require("../config/db");
const admin = require("firebase-admin");
const Groq = require("groq-sdk");

// Initialize the official Groq SDK
// This handles headers, retries, and errors much better than manual fetch
const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY,
});

// The current stable 2026 flagship model for Groq's free tier
const STABLE_MODEL = "llama-3.3-70b-versatile";

// Predefined expense categories (Sync'd with your OCR controller)
const EXPENSE_CATEGORIES = [
    "Food & Dining", "Transportation", "Shopping", "Bills & Utilities", 
    "Entertainment", "Travel", "Education", "Health & Fitness", 
    "Personal Care", "Home & Rent", "Groceries", "Investments", 
    "Insurance", "Gifts & Donations", "Other"
];

/**
 * Robust helper function to call Groq API using the SDK
 * @param {Array} messages - Chat history/prompts
 * @param {Boolean} jsonOnly - If true, forces JSON mode
 * @returns {Object} - The completion response
 */
const callGroqApi = async (messages, jsonOnly = false) => {
    try {
        // Deep clone messages to avoid accidental mutation
        const sessionMessages = JSON.parse(JSON.stringify(messages));

        if (jsonOnly && sessionMessages[0].role === "system") {
            sessionMessages[0].content += `\n\nIMPORTANT: You MUST respond ONLY with a valid JSON object. Do not include any text, greetings, or explanations before or after the JSON.`;
        }

        const completion = await groq.chat.completions.create({
            messages: sessionMessages,
            model: STABLE_MODEL,
            temperature: jsonOnly ? 0.0 : 0.7, // Lower temp for logic tasks to increase accuracy
            // This flag is crucial: it tells Groq to strictly enforce JSON output
            response_format: jsonOnly ? { type: "json_object" } : undefined,
        });

        return completion;
    } catch (error) {
        console.error("Internal Groq SDK Error:", error.message);
        throw error;
    }
};

/**
 * Helper to safely extract JSON from AI text responses
 */
const extractJsonFromText = (text) => {
    try {
        // Try standard parsing
        return JSON.parse(text);
    } catch (e) {
        // Use regex to find the JSON block if the AI added extra text
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try {
                return JSON.parse(jsonMatch[0]);
            } catch (innerError) {
                throw new Error("Found JSON structure but it was malformed.");
            }
        }
        throw new Error("No JSON found in response.");
    }
};

/**
 * Step 1: Detect User Intent
 */
const detectIntent = async (message) => {
    const prompt = `You are a financial assistant intent detector. Analyze the user message and choose one category:
- "add_expense": If user mentions spending, buying, paying for something, or a transaction.
- "query": If user asks about past spending, totals, or budget history.
- "chitchat": For greetings, jokes, or general conversation.

Respond ONLY with this JSON: {"intent": "add_expense|query|chitchat"}`;

    try {
        const response = await callGroqApi([
            { role: "system", content: prompt },
            { role: "user", content: message }
        ], true);

        const content = response.choices[0].message.content;
        const parsed = extractJsonFromText(content);
        return parsed.intent || "chitchat";
    } catch (error) {
        console.error("Intent Detection Error:", error.message);
        return "chitchat";
    }
};

/**
 * Step 2: Map User Categories to System Categories
 */
const mapToPreDefinedCategory = async (userCategory) => {
    const prompt = `Map the input to one of these predefined categories: ${EXPENSE_CATEGORIES.join(", ")}. 
    Respond ONLY with the category name. If unsure, respond "Other".`;

    try {
        const response = await callGroqApi([
            { role: "system", content: prompt },
            { role: "user", content: userCategory }
        ]);

        const mapped = response.choices[0].message.content.trim();
        return EXPENSE_CATEGORIES.includes(mapped) ? mapped : "Other";
    } catch (error) {
        return "Other";
    }
};

/**
 * Step 3: Extract Data for "Add Expense" intent
 */
const extractExpenseDetails = async (message) => {
    const today = new Date().toISOString().split('T')[0];
    const prompt = `Extract expense data into JSON.
Fields: "amount" (number), "category" (string), "date" (YYYY-MM-DD), "title" (max 2 words).
Assume today is ${today} if no date is mentioned.
Respond ONLY with the JSON object.`;

    try {
        const response = await callGroqApi([
            { role: "system", content: prompt },
            { role: "user", content: message }
        ], true);

        const content = response.choices[0].message.content;
        const details = extractJsonFromText(content);
        
        // Enhance the category mapping
        if (details.amount && details.category) {
            details.category = await mapToPreDefinedCategory(details.category);
        }
        
        return details;
    } catch (error) {
        return { error: "Could not parse expense details." };
    }
};

/**
 * Date Processing Utilities
 */
const processDatePeriod = (period) => {
    const today = new Date();
    const result = { from: null, to: null };
    result.to = today.toISOString().split('T')[0];
    const normalized = period.toLowerCase().trim();

    if (normalized === "today") {
        result.from = result.to;
    } else if (normalized === "yesterday") {
        const yesterday = new Date(today);
        yesterday.setDate(today.getDate() - 1);
        result.from = yesterday.toISOString().split('T')[0];
        result.to = result.from;
    } else if (["this week", "week"].includes(normalized)) {
        const firstDay = new Date(today);
        const day = today.getDay() || 7;
        firstDay.setDate(today.getDate() - day + 1);
        result.from = firstDay.toISOString().split('T')[0];
    } else if (["this month", "month"].includes(normalized)) {
        result.from = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
    } else if (["last month"].includes(normalized)) {
        const lastMonth = new Date(today);
        lastMonth.setMonth(today.getMonth() - 1);
        result.from = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}-01`;
        const lastDayOfLastMonth = new Date(today.getFullYear(), today.getMonth(), 0);
        result.to = lastDayOfLastMonth.toISOString().split('T')[0];
    } else {
        // Default to last 30 days
        const thirtyDaysAgo = new Date(today);
        thirtyDaysAgo.setDate(today.getDate() - 30);
        result.from = thirtyDaysAgo.toISOString().split('T')[0];
    }
    return result;
};

/**
 * Step 4: Handle "Query" intent
 */
const queryExpenses = async (message, userId) => {
    try {
        const prompt = `Extract query parameters into JSON: 
        {"category": "string|null", "time_period": "today|yesterday|this week|this month|last month|month name"}.
        Categories: ${EXPENSE_CATEGORIES.join(", ")}`;

        const response = await callGroqApi([
            { role: "system", content: prompt },
            { role: "user", content: message }
        ], true);

        const { category, time_period } = extractJsonFromText(response.choices[0].message.content);
        const { from, to } = processDatePeriod(time_period || "this month");

        let query = db.collection("expenses")
            .where("userId", "==", userId)
            .where("date", ">=", from)
            .where("date", "<=", to);
            
        let categoryFilter = null;
        if (category) {
            categoryFilter = await mapToPreDefinedCategory(category);
            query = query.where("category", "==", categoryFilter);
        }

        const snapshot = await query.get();
        if (snapshot.empty) {
            return `I couldn't find any expenses ${categoryFilter ? `for ${categoryFilter}` : ""} from ${from} to ${to}.`;
        }

        let total = 0;
        snapshot.forEach(doc => total += doc.data().amount);
        
        return `You spent ₹${total.toLocaleString()} ${categoryFilter ? `on ${categoryFilter}` : "in total"} for ${time_period || "this period"}.`;

    } catch (error) {
        return "I'm sorry, I'm having trouble accessing your expense history right now.";
    }
};

/**
 * Step 5: Handle "Chitchat" intent
 */
const generateChitchatResponse = async (message) => {
    try {
        const response = await callGroqApi([
            {
                role: "system",
                content: "You are WalletWise, a friendly and polite financial assistant. Keep your answers helpful and under 2 sentences."
            },
            { role: "user", content: message }
        ]);
        return response.choices[0].message.content;
    } catch (error) {
        return "I'm here to help you manage your money! What can I do for you today?";
    }
};

/**
 * Month Name Shortcut Logic
 */
const handleMonthNameResponse = async (message, userId) => {
    const monthNames = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
    const normalized = message.toLowerCase();
    const matched = monthNames.find(m => normalized.includes(m));
    if (matched) return await queryExpenses(`Expenses for ${matched}`, userId);
    return null;
};

// Simple context cache to track conversational flow
const conversationCache = new Map();

/**
 * MAIN CONTROLLER EXPORT
 */
exports.interactWithChatbot = async (req, res) => {
    const { message } = req.body;
    const userId = req.user.uid;

    if (!message) return res.status(400).json({ error: "Message is required" });

    try {
        // Priority 1: Check if it's a month-name shortcut
        const monthRes = await handleMonthNameResponse(message, userId);
        if (monthRes) return res.json({ success: true, message: monthRes });

        // Priority 2: Initialize or Refresh Context
        if (!conversationCache.has(userId)) {
            conversationCache.set(userId, { lastIntent: null, timestamp: Date.now() });
        }
        const context = conversationCache.get(userId);

        // Priority 3: Detect Intent and Execute
        const intent = await detectIntent(message);
        context.lastIntent = intent;
        context.timestamp = Date.now();

        // ADD EXPENSE
        if (intent === "add_expense") {
            const details = await extractExpenseDetails(message);
            if (details.error) return res.status(400).json({ error: details.error });

            const { amount, category, date, title } = details;
            
            await db.collection("expenses").add({
                userId,
                amount: parseFloat(amount),
                category,
                date,
                title,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            return res.json({ 
                success: true, 
                message: `✅ Logged ₹${amount} for "${title}" in ${category}.` 
            });
        }

        // QUERY EXPENSES
        if (intent === "query") {
            const queryResult = await queryExpenses(message, userId);
            return res.json({ success: true, message: queryResult });
        }

        // CHITCHAT / DEFAULT
        const reply = await generateChitchatResponse(message);
        return res.json({ success: true, message: reply });

    } catch (err) {
        console.error("Critical Chatbot Error:", err);
        return res.status(500).json({ 
            error: "Something went wrong.",
            message: "I'm having trouble connecting to my brain! Try asking again in a moment."
        });
    }
};
