class ExpenseAIAdvisor {
  static analyzeSpending(transactions, monthlyBudget = 1000) {
    if (!transactions || transactions.length === 0) {
      return { status: "info", message: "No transaction data available yet to generate AI insights." };
    }

    const totalSpent = transactions.reduce((acc, curr) => acc + (parseFloat(curr.amount) || 0), 0);
    const categoryTotals = {};
    
    transactions.forEach(t => {
      categoryTotals[t.category] = (categoryTotals[t.category] || 0) + (parseFloat(t.amount) || 0);
    });

    let topCategory = Object.keys(categoryTotals).reduce((a, b) => categoryTotals[a] > categoryTotals[b] ? a : b, "General");
    const topCategoryPercent = Math.round((categoryTotals[topCategory] / totalSpent) * 100);

    if (totalSpent > monthlyBudget) {
      return {
        status: "warning",
        message: `⚠️ Over Budget Warning: You have spent $${totalSpent.toFixed(2)}, exceeding your $${monthlyBudget} budget. Highest expense sector: ${topCategory} (${topCategoryPercent}% of total).`
      };
    }

    return {
      status: "success",
      message: `💡 Smart Insight: You are currently within your budget ($${totalSpent.toFixed(2)} / $${monthlyBudget}). Highest allocation: ${topCategory} (${topCategoryPercent}%).`
    };
  }
}
