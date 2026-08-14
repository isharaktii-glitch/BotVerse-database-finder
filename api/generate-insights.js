const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });

  let decoded;
  try {
    decoded = jwt.verify(authHeader.replace('Bearer ', ''), process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const { conversationId } = req.body;
  if (!conversationId) return res.status(400).json({ error: 'conversationId required' });

  try {
    const dataResult = await pool.query(
      'SELECT data_json, data_name FROM business_data WHERE conversation_id = $1 AND user_id = $2 ORDER BY uploaded_at DESC LIMIT 1',
      [conversationId, decoded.userId]
    );

    if (dataResult.rows.length === 0) {
      return res.status(400).json({ error: 'No data found' });
    }

    const businessData = dataResult.rows[0].data_json;
    const contextText = JSON.stringify(businessData).slice(0, 15000);

    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    const prompt = `Analyze this business data and extract 3 KEY INSIGHTS:
1. Top Performing Item / Highest Revenue area
2. Key Trend / Growth pattern
3. Potential Business Risk or Area of Improvement

Data:
${contextText}

Respond ONLY with JSON in this exact structure:
{
  "insights": [
    {
      "id": "top_product",
      "type": "success",
      "title": "Top Product / Feature",
      "summary": "Short 1-sentence summary",
      "detail": "Detailed breakdown explaining why it's performing well and exact metrics."
    },
    {
      "id": "trend",
      "type": "info",
      "title": "Key Business Trend",
      "summary": "Short 1-sentence summary",
      "detail": "Detailed explanation of the trend observed over time."
    },
    {
      "id": "risk",
      "type": "warning",
      "title": "Identified Risk / Warning",
      "summary": "Short 1-sentence summary",
      "detail": "Detailed explanation of the potential risk and mitigation advice."
    }
  ]
}

DO NOT INCLUDE MARKDOWN CODE FENCES. OUTPUT ONLY CLEAN JSON.`;

    const result = await model.generateContent(prompt);
    let rawText = result.response.text().trim();
    rawText = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    const parsed = JSON.parse(rawText);
    res.status(200).json({ success: true, insights: parsed.insights });

  } catch (err) {
    console.error('INSIGHTS ERROR:', err.message);
    res.status(500).json({ error: 'Failed to generate insights' });
  }
};
