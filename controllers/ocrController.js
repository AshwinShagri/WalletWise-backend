// controllers/ocrController.js

const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('../config/db');

// Initialize Gemini API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
console.log("Gemini API Key being used:", process.env.GEMINI_API_KEY);

// Function to get exchange rates
const getExchangeRate = async (fromCurrency, toCurrency) => {
  console.log(`Fetching exchange rate from ${fromCurrency} to ${toCurrency}`);
  try {
    const response = await axios.get(
      `https://api.exchangerate-api.com/v4/latest/${fromCurrency}`
    );
    console.log('Exchange rate API response:', response.data);
    return response.data.rates[toCurrency];
  } catch (error) {
    console.error('Error fetching exchange rate:', error.message);
    throw new Error('Failed to fetch exchange rate');
  }
};

// Process receipt image with Gemini
exports.processReceipt = async (req, res) => {
  try {
    console.log('Starting processReceipt function');
    const userId = req.user.uid;
    const { convertCurrency = false, defaultCurrency = 'INR' } = req.body;

    console.log('User ID from request:', userId);
    console.log('Convert currency:', convertCurrency);
    console.log('Default currency:', defaultCurrency);

    // Check if image is provided
    if (!req.file) {
      console.error('No image provided in the request');
      return res.status(400).json({ error: 'No image provided' });
    }

    console.log('Image received:', req.file.originalname, 'Mimetype:', req.file.mimetype, 'Size:', req.file.size);

    // Get the image file from multer
    const imageBuffer = req.file.buffer;
    const base64Image = imageBuffer.toString('base64');
    console.log('Image converted to base64');

    // Get user currency preference
    console.log('Fetching user currency preference from Firestore');
    const userDoc = await db.collection('users').doc(userId).get();
    const userPreferences = userDoc.data();
    let userCurrency = defaultCurrency;

    if (userPreferences && userPreferences.currency) {
      userCurrency = userPreferences.currency.split(' ')[0];
      console.log('User currency from Firestore:', userCurrency);
    } else {
      console.log('User currency not found in Firestore, using default:', defaultCurrency);
    }

    // Call Gemini Vision API to analyze the receipt
    console.log('Calling Gemini Vision API');
    const model = genAI.getGenerativeModel(
  { model: 'gemini-2.5-flash' }, 
  { apiVersion: 'v1' }
);
    
    const predefinedCategories = [
      "Food & Dining",
      "Transportation",
      "Shopping",
      "Bills & Utilities",
      "Entertainment",
      "Travel",
      "Education",
      "Health & Fitness",
      "Personal Care",
      "Home & Rent",
      "Groceries",
      "Investments",
      "Insurance",
      "Gifts & Donations"
    ];
    
    const prompt = `Analyze this receipt image and extract the following information in JSON format:

1. Total amount
2. Currency code (e.g., USD, EUR, INR)
3. Date (if available)

For the category, please FIRST try to classify the expense into one of these predefined categories:
${predefinedCategories.join(", ")}

ONLY if the expense clearly doesn't fit any of these categories, then use "Other".

Also, create a short descriptive title for this receipt (maximum 2 words).

Respond only with valid JSON in this format:
{
  "total": number,
  "currency": "string",
  "category": "string",
  "date": "string (YYYY-MM-DD format or empty string if not found)",
  "title": "string (1-2 words)"
}`;

    const imagePart = {
      inlineData: {
        data: base64Image,
        mimeType: req.file.mimetype,
      },
    };

    console.log('Gemini API prompt:', prompt);
    const result = await model.generateContent([prompt, imagePart]);
    const response = await result.response;
    const text = response.text();
    console.log('Gemini API response text:', text);

    // Extract JSON from the response
    const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/) || text.match(/{[\s\S]*?}/);
    let extractedData;

    if (jsonMatch) {
      try {
        extractedData = JSON.parse(jsonMatch[1] || jsonMatch[0]);
        console.log('Extracted data from Gemini:', extractedData);
      } catch (e) {
        console.error('Error parsing JSON from Gemini:', e.message);
        return res.status(500).json({ error: 'Failed to parse receipt data' });
      }
    } else {
      console.error('Failed to extract structured data from receipt');
      return res.status(500).json({ error: 'Failed to extract structured data from receipt' });
    }

    // Round the total to 2 decimal places
    extractedData.total = parseFloat(extractedData.total.toFixed(2));

    // Handle currency conversion if needed
    let convertedAmount = extractedData.total;
    let originalCurrency = extractedData.currency;

    if (convertCurrency && originalCurrency !== userCurrency) {
      console.log(`Attempting currency conversion from ${originalCurrency} to ${userCurrency}`);
      try {
        const rate = await getExchangeRate(originalCurrency, userCurrency);
        convertedAmount = parseFloat((extractedData.total * rate).toFixed(2)); // Round to 2 decimal places
        console.log('Conversion rate:', rate, 'Converted amount:', convertedAmount);
      } catch (error) {
        console.error('Currency conversion error:', error.message);
        // Continue with original amount if conversion fails
      }
    } else {
      console.log('Currency conversion not needed or skipped.');
    }

    // Return the data without storing it in the database
    // The data will be stored only when the user clicks "Add Expense"
    res.status(200).json({
      message: 'Receipt processed successfully',
      data: {
        total: extractedData.total,
        currency: extractedData.currency,
        category: extractedData.category,
        date: extractedData.date || new Date().toISOString().split('T')[0],
        title: extractedData.title || 'Receipt',
        convertedAmount: convertedAmount !== extractedData.total ? convertedAmount : null,
        convertedCurrency: convertCurrency ? userCurrency : null
      }
    });

  } catch (error) {
    console.error('OCR Processing Error:', error);
    res.status(500).json({ error: 'Failed to process receipt' });
  } finally {
    console.log('Finished processReceipt function');
  }
};

// New endpoint to add the expense after user confirms
exports.addExpense = async (req, res) => {
  try {
    const userId = req.user.uid;
    const expenseData = {
      ...req.body,
      userId,
      source: 'ocr',
      createdAt: new Date()
    };
    
    // Remove merchant data if present
    if (expenseData.merchant) {
      delete expenseData.merchant;
    }
    
    // Ensure amounts are rounded to 2 decimal places
    if (expenseData.amount) {
      expenseData.amount = parseFloat(parseFloat(expenseData.amount).toFixed(2));
    }
    
    if (expenseData.originalAmount) {
      expenseData.originalAmount = parseFloat(parseFloat(expenseData.originalAmount).toFixed(2));
    }
    
    console.log('Adding expense to database:', expenseData);
    const expenseRef = await db.collection('expenses').add(expenseData);
    
    res.status(200).json({
      message: 'Expense added successfully',
      expenseId: expenseRef.id,
      success: true
    });
  } catch (error) {
    console.error('Error adding expense:', error);
    res.status(500).json({ error: 'Failed to add expense', success: false });
  }
};
