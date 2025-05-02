const db = require("../config/db");

// Helper function to calculate category totals from a snapshot
const calculateCategoryTotals = (snapshot) => {
    const totals = {};
    let totalAmount = 0;
    snapshot.forEach(doc => {
        const data = doc.data();
        try {
            const amount = parseFloat(data.amount);
            if (isNaN(amount)) {
                console.warn(`Invalid amount found for expense ID ${doc.id}:`, data.amount);
                return; // Skip this expense
            }
            totalAmount += amount;
            if (!totals[data.category]) {
                totals[data.category] = 0;
            }
            totals[data.category] += amount;
        } catch (parseError) {
            console.warn(`Error parsing amount for expense ID ${doc.id}:`, parseError);
        }
    });
    return { totals, totalAmount };
};

exports.getAnalytics = async (req, res) => {
    try {
        const { uid } = req.user;
        const { timeframe = "month", customStart, customEnd } = req.query;

        // --- Date Calculation Logic ---
        const today = new Date();
        let startDate, endDate;
        let previousStartDate, previousEndDate;

        endDate = today.toISOString().split('T')[0]; // Today's date in YYYY-MM-DD

        // Handle custom date range
        if (timeframe === "custom" && customStart && customEnd) {
            startDate = customStart;
            endDate = customEnd;
           
            // Calculate previous period as same length before custom range
            const diffDays = Math.round((new Date(endDate) - new Date(startDate)) / (1000 * 60 * 60 * 24));
            const prevEnd = new Date(startDate);
            prevEnd.setDate(prevEnd.getDate() - 1);
            const prevStart = new Date(prevEnd);
            prevStart.setDate(prevStart.getDate() - diffDays);
           
            previousStartDate = prevStart.toISOString().split('T')[0];
            previousEndDate = prevEnd.toISOString().split('T')[0];
        }
        else {
            // Standard timeframes
            if (timeframe === "day") {
                startDate = endDate;
                previousEndDate = new Date(today);
                previousEndDate.setDate(previousEndDate.getDate() - 1);
                previousEndDate = previousEndDate.toISOString().split('T')[0];
                previousStartDate = previousEndDate;
            }
            else if (timeframe === "week") {
                const day = today.getDay();
                const diff = today.getDate() - day + (day === 0 ? -6 : 1); // Adjust for Sunday
                startDate = new Date(today.setDate(diff)).toISOString().split('T')[0];
               
                previousEndDate = new Date(startDate);
                previousEndDate.setDate(previousEndDate.getDate() - 1);
                previousStartDate = new Date(previousEndDate);
                previousStartDate.setDate(previousStartDate.getDate() - 6);
                previousEndDate = previousEndDate.toISOString().split('T')[0];
                previousStartDate = previousStartDate.toISOString().split('T')[0];
            }
            else if (timeframe === "month") {
                // Set startDate to first day of current month
                startDate = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
                
                // Set endDate to last day of current month
                endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0).toISOString().split('T')[0];
                
                // Previous period is previous month (full calendar month)
                previousStartDate = new Date(today.getFullYear(), today.getMonth() - 1, 1).toISOString().split('T')[0];
                previousEndDate = new Date(today.getFullYear(), today.getMonth(), 0).toISOString().split('T')[0];
            }
            else if (timeframe === "quarter") {
                const currentQuarter = Math.floor(today.getMonth() / 3);
                startDate = new Date(today.getFullYear(), currentQuarter * 3, 1).toISOString().split('T')[0];
                previousEndDate = new Date(today.getFullYear(), currentQuarter * 3, 0).toISOString().split('T')[0];
                previousStartDate = new Date(today.getFullYear(), (currentQuarter - 1) * 3, 1).toISOString().split('T')[0];
                if (currentQuarter === 0) {
                    previousStartDate = new Date(today.getFullYear() - 1, 9, 1).toISOString().split('T')[0];
                    previousEndDate = new Date(today.getFullYear() - 1, 11, 31).toISOString().split('T')[0];
                }
            }
            else if (timeframe === "year") {
                startDate = new Date(today.getFullYear(), 0, 1).toISOString().split('T')[0];
                previousStartDate = new Date(today.getFullYear() - 1, 0, 1).toISOString().split('T')[0];
                previousEndDate = new Date(today.getFullYear() - 1, 11, 31).toISOString().split('T')[0];
            }
        }

        const expensesRef = db.collection("expenses");

        // Query for current period expenses
        const currentPeriodQuery = expensesRef
            .where("userId", "==", uid)
            .where("date", ">=", startDate)
            .where("date", "<=", endDate);

        // Query for previous period expenses
        const previousPeriodQuery = expensesRef
            .where("userId", "==", uid)
            .where("date", ">=", previousStartDate)
            .where("date", "<=", previousEndDate);

        // Fetch data concurrently
        const [currentPeriodSnapshot, previousPeriodSnapshot] = await Promise.all([
            currentPeriodQuery.get(),
            previousPeriodQuery.get()
        ]);

        // --- Process Current Period ---
        const expenses = [];
        const dailySpending = {};
        const { totals: currentCategoryTotals, totalAmount: totalSpent } = calculateCategoryTotals(currentPeriodSnapshot);

        currentPeriodSnapshot.forEach(doc => {
            const data = doc.data();
            try {
                const amount = parseFloat(data.amount);
                if (isNaN(amount)) return;

                // Add to expenses array (for top expenses)
                expenses.push({
                    id: doc.id,
                    ...data,
                    amount: amount
                });

                // Add to daily spending
                if (!dailySpending[data.date]) {
                    dailySpending[data.date] = 0;
                }
                dailySpending[data.date] += amount;
            } catch(e) {/* ignore */}
        });

        // --- Process Previous Period ---
        const { totals: previousCategoryTotals, totalAmount: previousPeriodTotal } = calculateCategoryTotals(previousPeriodSnapshot);

        // --- Calculate Metrics ---
        // Average Daily Spending
        const daysInPeriod = Math.max(1, Math.round((new Date(endDate).getTime() - new Date(startDate).getTime()) / (1000 * 60 * 60 * 24)) + 1);
        const avgDailySpent = totalSpent / daysInPeriod;

        // Category Breakdown (Current Period)
        const categoryBreakdown = Object.entries(currentCategoryTotals)
            .map(([name, value]) => ({ name, value }))
            .sort((a, b) => b.value - a.value);

        // Spending Trend (Fill missing days)
        const spendingTrend = [];
        let currentDateIterator = new Date(startDate + 'T00:00:00Z');
        let endDateObj = new Date(endDate + 'T00:00:00Z');

        // When filling the spending trend data, ensure we're using exact month boundaries
        if (timeframe === "month") {
            // Reset currentDateIterator to exactly the 1st of the month
            currentDateIterator = new Date(today.getFullYear(), today.getMonth(), 1);
            // And set endDateObj to the last day of the month
            endDateObj = new Date(today.getFullYear(), today.getMonth() + 1, 0);
        }

        while (currentDateIterator <= endDateObj) {
            const dateStr = currentDateIterator.toISOString().split('T')[0];
            spendingTrend.push({
                date: dateStr,
                amount: dailySpending[dateStr] || 0
            });
            currentDateIterator.setDate(currentDateIterator.getDate() + 1);
        }

        // Top Expenses
        const topExpenses = expenses
            .sort((a, b) => b.amount - a.amount)
            .slice(0, 5)
            .map(expense => ({
                title: expense.title,
                amount: expense.amount,
                category: expense.category,
                date: expense.date
            }));

        // --- Comparison Calculations ---
        // Overall Comparison
        let percentChange = 0;
        if (previousPeriodTotal > 0) {
            percentChange = Math.round(((totalSpent - previousPeriodTotal) / previousPeriodTotal) * 10000) / 100;
        } else if (totalSpent > 0) {
            percentChange = Infinity;
        }

        // Category Comparison
        const categoryComparison = categoryBreakdown.map(currentCat => {
            const previousValue = previousCategoryTotals[currentCat.name] || 0;
            let catPercentChange = 0;
            if (previousValue > 0) {
                catPercentChange = Math.round(((currentCat.value - previousValue) / previousValue) * 10000) / 100;
            } else if (currentCat.value > 0) {
                catPercentChange = Infinity;
            }
            return {
                name: currentCat.name,
                currentValue: currentCat.value,
                previousValue: previousValue,
                percentChange: catPercentChange
            };
        });

        // Add categories from the previous period that don't exist in the current one
        Object.keys(previousCategoryTotals).forEach(prevCatName => {
            if (!currentCategoryTotals[prevCatName]) {
                categoryComparison.push({
                    name: prevCatName,
                    currentValue: 0,
                    previousValue: previousCategoryTotals[prevCatName],
                    percentChange: -100
                });
            }
        });

        res.status(200).json({
            totalSpent,
            avgDailySpent: avgDailySpent || 0,
            categoryBreakdown,
            spendingTrend,
            topExpenses,
            comparison: {
                currentPeriodTotal: totalSpent,
                previousPeriodTotal: previousPeriodTotal,
                percentChange,
            },
            categoryComparison,
            timeframe
        });

    } catch (error) {
        console.error("Error getting analytics:", error);
        res.status(500).json({ error: "Failed to retrieve analytics data" });
    }
};