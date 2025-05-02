const db = require("../config/db");
const admin = require("firebase-admin");
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_API_URL = 'https://api.groq.com/openai/v1';

// Predefined expense categories
const EXPENSE_CATEGORIES = [
    "Food & Dining", "Transportation", "Shopping", "Bills & Utilities", 
    "Entertainment", "Travel", "Education", "Health & Fitness", 
    "Personal Care", "Home & Rent", "Groceries", "Investments", 
    "Insurance", "Gifts & Donations", "Other"
];

// Function to call Groq API with retry mechanism
const callGroqApi = async (messages, model, jsonOnly = false, retries = 2) => {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const systemMessage = messages[0];
            // If jsonOnly is true, enhance the system prompt to force JSON output
            if (jsonOnly && systemMessage.role === "system") {
                systemMessage.content += `\n\nIMPORTANT: You MUST respond ONLY with valid JSON. No explanations, no text before or after the JSON.`;
            }

            const response = await fetch(`${GROQ_API_URL}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${GROQ_API_KEY}`,
                },
                body: JSON.stringify({ 
                    messages, 
                    model,
                    temperature: jsonOnly ? 0.1 : 0.7 // Lower temperature for structured outputs
                }),
            });

            if (!response.ok) {
                const errorBody = await response.json();
                throw new Error(`Groq API Error: ${errorBody.message || 'Unknown error'}`);
            }

            return await response.json();
        } catch (error) {
            if (attempt === retries) {
                console.error(`Failed after ${retries} attempts to call Groq API:`, error);
                throw error;
            }
            // Exponential backoff before retry
            await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
        }
    }
};

// Extract JSON from a potentially mixed text response
const extractJsonFromText = (text) => {
    try {
        // Try direct parsing first
        return JSON.parse(text);
    } catch (e) {
        // Look for JSON-like structure with regex
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try {
                return JSON.parse(jsonMatch[0]);
            } catch (innerError) {
                throw new Error("Could not extract valid JSON from response");
            }
        }
        throw new Error("No JSON structure found in response");
    }
};

// Detect intent from user message
const detectIntent = async (message) => {
    const prompt = `You are an assistant that detects intent. Choose only one:
- "add_expense" if the user mentions spending, buying, paying for something, or a transaction
- "query" if the user is asking about past spending, totals, or any question about their expenses
- "chitchat" for greetings, jokes, general conversation, or anything not clearly about adding or querying expenses

Respond ONLY with:
{"intent": "<one_of_add_expense|query|chitchat>"}`;

    try {
        const response = await callGroqApi([
            { role: "system", content: prompt },
            { role: "user", content: message }
        ], "llama3-8b-8192", true);

        const content = response.choices[0].message.content;
        const parsedContent = extractJsonFromText(content);
        return parsedContent.intent || "chitchat";
    } catch (error) {
        console.error("Error detecting intent:", error);
        return "chitchat"; // Default fallback
    }
};

// Map user category to predefined categories
const mapToPreDefinedCategory = async (userCategory) => {
    const prompt = `Map the following user-entered expense category to one of these predefined categories:
${EXPENSE_CATEGORIES.join(", ")}

User category: "${userCategory}"

Respond ONLY with the SINGLE best matching category from the list. Choose the closest match.`;

    try {
        const response = await callGroqApi([
            { role: "system", content: prompt },
            { role: "user", content: userCategory }
        ], "llama3-8b-8192");

        const mappedCategory = response.choices[0].message.content.trim();
        
        // Validate that the response is one of our predefined categories
        if (EXPENSE_CATEGORIES.includes(mappedCategory)) {
            return mappedCategory;
        }
        
        // Default to "Other" if no valid match
        return "Other";
    } catch (error) {
        console.error("Error mapping category:", error);
        return "Other"; // Default fallback
    }
};

// Extract expense details from user message
const extractExpenseDetails = async (message) => {
    const today = new Date().toISOString().split('T')[0];
    const prompt = `Extract expense data from text. Return JSON with these fields:
- amount (number only, no currency symbol)
- category (descriptive phrase of what was purchased)
- date (YYYY-MM-DD, assume today ${today} if not specified)
- title (1-2 words describing the expense, concise and specific)

Examples:
"I spent 200 on groceries today at Walmart" =>
{"amount": 200, "category": "groceries", "date": "${today}", "title": "Walmart Groceries"}

"Movie night for 500 on April 1" =>
{"amount": 500, "category": "movie", "date": "2025-04-01", "title": "Movie Night"}

"Paid 1750 for rent today" =>
{"amount": 1750, "category": "rent", "date": "${today}", "title": "Monthly Rent"}

Respond ONLY in this JSON format or this error if invalid:
{"error": "Could not understand the expense details."}`;

    try {
        const response = await callGroqApi([
            { role: "system", content: prompt },
            { role: "user", content: message }
        ], "llama3-8b-8192", true);

        const content = response.choices[0].message.content;
        const parsedDetails = extractJsonFromText(content);
        
        // If valid response, map the user category to predefined category
        if (!parsedDetails.error) {
            parsedDetails.category = await mapToPreDefinedCategory(parsedDetails.category);
        }
        
        return parsedDetails;
    } catch (error) {
        console.error("Error extracting expense details:", error);
        return { error: "Failed to parse expense details." };
    }
};

// Process date periods for queries with improved recognition
const processDatePeriod = (period) => {
    const today = new Date();
    const result = { from: null, to: null };
    
    // Set end date to today by default
    result.to = today.toISOString().split('T')[0];
    
    // Normalize the period text to handle variations
    const normalizedPeriod = period.toLowerCase().trim();
    
    // Common time periods with variations
    if (normalizedPeriod === "today") {
        result.from = result.to;
    } else if (normalizedPeriod === "yesterday") {
        const yesterday = new Date(today);
        yesterday.setDate(today.getDate() - 1);
        result.from = yesterday.toISOString().split('T')[0];
        result.to = result.from;
    } else if (["this week", "current week", "the week", "week"].includes(normalizedPeriod)) {
        const firstDay = new Date(today);
        const day = today.getDay() || 7; // Convert Sunday from 0 to 7
        firstDay.setDate(today.getDate() - day + 1); // Monday of this week
        result.from = firstDay.toISOString().split('T')[0];
    } else if (["this month", "current month", "the month", "month"].includes(normalizedPeriod)) {
        result.from = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
    } else if (["last month", "previous month"].includes(normalizedPeriod)) {
        const lastMonth = new Date(today);
        lastMonth.setMonth(today.getMonth() - 1);
        result.from = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}-01`;
        
        const lastDayOfLastMonth = new Date(today.getFullYear(), today.getMonth(), 0);
        result.to = lastDayOfLastMonth.toISOString().split('T')[0];
    } else if (normalizedPeriod.includes("april") || normalizedPeriod.includes("apr")) {
        // Handle specific month mentions (April in this case)
        result.from = `${today.getFullYear()}-04-01`;
        result.to = `${today.getFullYear()}-04-30`;
    } else if (normalizedPeriod.includes("march") || normalizedPeriod.includes("mar")) {
        result.from = `${today.getFullYear()}-03-01`;
        result.to = `${today.getFullYear()}-03-31`;
    } else if (normalizedPeriod.includes("february") || normalizedPeriod.includes("feb")) {
        result.from = `${today.getFullYear()}-02-01`;
        result.to = `${today.getFullYear()}-02-${today.getFullYear() % 4 === 0 ? '29' : '28'}`;
    } else if (normalizedPeriod.includes("january") || normalizedPeriod.includes("jan")) {
        result.from = `${today.getFullYear()}-01-01`;
        result.to = `${today.getFullYear()}-01-31`;
    } else {
        // Default to last 30 days if period is unrecognized
        const thirtyDaysAgo = new Date(today);
        thirtyDaysAgo.setDate(today.getDate() - 30);
        result.from = thirtyDaysAgo.toISOString().split('T')[0];
    }
    
    return result;
};

// Parse various time-related expressions
const parseTimeExpression = (expression) => {
    const today = new Date();
    
    // Handle common expressions
    if (expression.match(/whole month|entire month|full month|this month|current month/i)) {
        return "this month";
    }
    if (expression.match(/last month|previous month/i)) {
        return "last month";
    }
    if (expression.match(/this week|current week/i)) {
        return "this week";
    }
    if (expression.match(/today/i)) {
        return "today";
    }
    if (expression.match(/yesterday/i)) {
        return "yesterday";
    }
    
    // Handle month names
    const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
    const monthAbbreviations = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    
    for (let i = 0; i < months.length; i++) {
        if (expression.includes(months[i]) || expression.includes(monthAbbreviations[i])) {
            return months[i];
        }
    }
    
    // Default
    return "this month";
};

// Improved function to handle expense queries
const queryExpenses = async (message, userId) => {
    try {
        const prompt = `You are a finance assistant. Extract query details from the user's message about expenses.
Return ONLY JSON with these fields:
- category: The expense category they're asking about (null if not specified)
- time_period: The time period they're asking about (today, yesterday, this week, this month, last month, or a specific month name)

Examples:
"How much did I spend on food this month?" => {"category": "Food & Dining", "time_period": "this month"}
"Show me yesterday's expenses" => {"category": null, "time_period": "yesterday"}
"What did I spend on transportation last month?" => {"category": "Transportation", "time_period": "last month"}
"How much did I spend this whole month" => {"category": null, "time_period": "this month"}
"What were my expenses in April?" => {"category": null, "time_period": "april"}

The available expense categories are: ${EXPENSE_CATEGORIES.join(", ")}
Map to the closest category or return null if no category is mentioned.`;

        const apiResponse = await callGroqApi([
            { role: "system", content: prompt },
            { role: "user", content: message }
        ], "llama3-8b-8192", true);

        // Parse query parameters
        let queryParams;
        try {
            queryParams = extractJsonFromText(apiResponse.choices[0].message.content);
        } catch (error) {
            console.error("Failed to parse query parameters:", error);
            
            // Fallback approach: Use a simpler parsing strategy
            const category = EXPENSE_CATEGORIES.find(cat => 
                message.toLowerCase().includes(cat.toLowerCase())
            );
            
            let time_period = "this month"; // Default
            
            // Very simple time period detection as backup
            if (message.toLowerCase().includes("today")) {
                time_period = "today";
            } else if (message.toLowerCase().includes("yesterday")) {
                time_period = "yesterday";
            } else if (message.toLowerCase().includes("week")) {
                time_period = "this week";
            } else if (message.toLowerCase().includes("month")) {
                time_period = parseTimeExpression(message.toLowerCase());
            }
            
            queryParams = { 
                category: category || null, 
                time_period 
            };
        }
        
        const { category, time_period } = queryParams;
        
        // Process the date period to get from/to dates
        const { from, to } = processDatePeriod(time_period);
        
        // Build the Firebase query
        let query = db.collection("expenses")
            .where("userId", "==", userId)
            .where("date", ">=", from)
            .where("date", "<=", to);
            
        let categoryFilter = null;
        if (category) {
            // If category is specified, try to map it to our predefined categories
            categoryFilter = await mapToPreDefinedCategory(category);
            query = query.where("category", "==", categoryFilter);
        }

        // Execute query
        const snapshot = await query.get();
        
        if (snapshot.empty) {
            return `No expenses found ${categoryFilter ? `for ${categoryFilter}` : ""} ${time_period}.`;
        }

        // Process results
        let total = 0;
        const expenses = [];
        
        snapshot.forEach(doc => {
            const data = doc.data();
            total += data.amount;
            expenses.push(data);
        });

        // Format the time period for display
        let formattedPeriod;
        if (time_period === "today") {
            formattedPeriod = "today";
        } else if (time_period === "yesterday") {
            formattedPeriod = "yesterday";
        } else if (time_period === "this week" || time_period === "current week") {
            formattedPeriod = "this week";
        } else if (time_period === "this month" || time_period === "current month") {
            formattedPeriod = "this month";
        } else if (time_period === "last month" || time_period === "previous month") {
            formattedPeriod = "last month";
        } else if (time_period.match(/january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i)) {
            // If it's a month name, capitalize the first letter
            formattedPeriod = "in " + time_period.charAt(0).toUpperCase() + time_period.slice(1);
        } else {
            formattedPeriod = `for ${time_period}`;
        }

        const categoryText = categoryFilter ? `on ${categoryFilter}` : "in total";
        
        let response = `You spent ₹${total.toLocaleString()} ${categoryText} ${formattedPeriod} (${expenses.length} transaction${expenses.length !== 1 ? 's' : ''}).`;
        
        // Add breakdown of top categories if no category filter was applied
        if (!categoryFilter && expenses.length > 1) {
            // Group by category
            const categoryTotals = {};
            expenses.forEach(exp => {
                if (!categoryTotals[exp.category]) categoryTotals[exp.category] = 0;
                categoryTotals[exp.category] += exp.amount;
            });
            
            // Get top 3 categories
            const topCategories = Object.entries(categoryTotals)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3);
                
            if (topCategories.length > 0) {
                response += " Top categories: " + topCategories
                    .map(([cat, amt]) => `${cat} (₹${amt.toLocaleString()})`)
                    .join(", ");
            }
        }
        
        return response;
        
    } catch (error) {
        console.error("Error processing query:", error);
        return "I couldn't process your query. Please try asking in a different way, like 'How much did I spend this month?' or 'What were my food expenses yesterday?'";
    }
};

// Generate chitchat responses
const generateChitchatResponse = async (message) => {
    try {
        const response = await callGroqApi([
            {
                role: "system",
                content: `You are a friendly expense-tracking assistant who replies casually and politely. 
                Keep replies short, natural and helpful. You help users track their spending. If they ask about
                spending or expenses but you can't understand the specific query, suggest they try asking in a clearer format
                like "How much did I spend on [category] [time period]?" or "What were my expenses [time period]?".`,
            },
            { role: "user", content: message }
        ], "llama3-8b-8192");

        return response.choices[0].message.content;
    } catch (error) {
        console.error("Error generating chitchat response:", error);
        return "I'm here to help with your expenses. You can ask me things like 'How much did I spend this month?' or tell me about new expenses like 'I spent ₹200 on lunch today'.";
    }
};

// Handle month name responses
const handleMonthNameResponse = async (message, userId) => {
    // Check if message contains a month name
    const monthNames = ["january", "february", "march", "april", "may", "june", 
                        "july", "august", "september", "october", "november", "december",
                        "jan", "feb", "mar", "apr", "may", "jun", 
                        "jul", "aug", "sep", "oct", "nov", "dec"];
    
    const normalizedMessage = message.toLowerCase();
    const matchedMonth = monthNames.find(month => normalizedMessage.includes(month));
    
    if (matchedMonth) {
        // Treat this as a query for that month
        return await queryExpenses(`How much did I spend in ${matchedMonth}?`, userId);
    }
    
    return null; // Not a month name response
};

// Main controller function with conversation context
const conversationCache = new Map(); // Simple in-memory cache for conversation context

exports.interactWithChatbot = async (req, res) => {
    const { message } = req.body;
    const userId = req.user.uid;

    try {
        // Check if this might be a follow-up about a month
        const monthResponse = await handleMonthNameResponse(message, userId);
        if (monthResponse) {
            return res.json({ success: true, message: monthResponse });
        }

        // Get conversation context or initialize it
        if (!conversationCache.has(userId)) {
            conversationCache.set(userId, {
                lastIntent: null,
                lastQuery: null,
                timestamp: Date.now()
            });
        }
        
        const context = conversationCache.get(userId);
        
        // Check if we should clear context due to time (expire after 30 minutes)
        if (Date.now() - context.timestamp > 30 * 60 * 1000) {
            context.lastIntent = null;
            context.lastQuery = null;
        }
        
        // Update timestamp
        context.timestamp = Date.now();

        // Detect intent
        const intent = await detectIntent(message);
        context.lastIntent = intent;

        if (intent === "add_expense") {
            const details = await extractExpenseDetails(message);
            if (details.error) return res.status(400).json({ error: details.error });

            const { amount, category, date, title } = details;
            if (isNaN(parseFloat(amount)) || !category || !date || !title) {
                return res.status(400).json({ error: "Incomplete expense information." });
            }

            // Add the expense to Firestore
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
                message: `✅ Added ₹${amount} for ${title} (${category}) on ${date}.` 
            });
        }

        if (intent === "query") {
            context.lastQuery = message;
            const result = await queryExpenses(message, userId);
            return res.json({ success: true, message: result });
        }

        // Special handling for month names if the previous intent was a query
        if (context.lastIntent === "query" && /^(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)$/i.test(message.trim())) {
            const result = await queryExpenses(`How much did I spend in ${message.trim()}?`, userId);
            return res.json({ success: true, message: result });
        }

        const reply = await generateChitchatResponse(message);
        return res.json({ success: true, message: reply });

    } catch (err) {
        console.error("Chatbot error:", err);
        return res.status(500).json({ 
            error: "Something went wrong while processing your message.",
            message: "I'm having trouble understanding that. Try asking about your spending like 'How much did I spend today?' or add an expense like 'I spent ₹250 on dinner'."
        });
    }
};