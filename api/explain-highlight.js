const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });

  const token = authHeader.replace('Bearer ', '');
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const { conversationId, highlightTitle, highlightDesc } = req.body;
  if (!conversationId) return res.status(400).json({ error: 'conversationId required' });
  if (!highlightTitle) return res.status(400).json({ error: 'highlightTitle required' });

  try {
    const dataResult = await pool.query(
      'SELECT data_json, data_name FROM business_data WHERE conversation_id = $1 AND user_id = $2 ORDER BY uploaded_at DESC LIMIT 1',
      [conversationId, decoded.userId]
    );

    if (dataResult.rows.length === 0) {
      return res.status(400).json({ error: 'No data found for this conversation.' });
    }

    const businessData = dataResult.rows[0].data_json;
    const dataName = dataResult.rows[0].data_name;

    const model = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });

    let contextText;
    if (businessData && businessData.type === 'website') {
      contextText = `Website content from ${businessData.url}:\n\n${businessData.content}`;
    } else if (businessData && businessData.type === 'document') {
      contextText = `Document content:\n\n${businessData.text}`;
    } else {
      contextText = JSON.stringify(businessData).slice(0, 15000);
    }

    const prompt = `You are a business data analyst. Here is a data source called "${dataName}":

${contextText}

Earlier you flagged this insight: "${highlightTitle}" — ${highlightDesc}

Now give a full, detailed explanation of this specific insight. Explain WHY it's happening, what the specific numbers are, and if relevant, what it might mean for the business. Write 4-8 sentences.

Decide if a chart would help illustrate this specific insight. Respond ONLY with valid JSON, no markdown fences, no extra text:

{
  "explanation": "Full detailed explanation here, same language as the data/title above.",
  "includeChart": true or false,
  "chart": { "chartType": "bar|line|pie", "title": "Chart title", "labels": ["Label1"], "datasets": [{"label": "Series", "data": [123]}] } or null
}`;

    const result = await model.generateContent(prompt);
    let rawText = result.response.text().trim();
    rawText = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (e) {
      parsed = { explanation: rawText, includeChart: false, chart: null };
    }

    if (typeof parsed.includeChart !== 'boolean') parsed.includeChart = false;

    res.status(200).json({ success: true, ...parsed });

  } catch (err) {
    console.error('EXPLAIN HIGHLIGHT ERROR:', err.message);
    res.status(500).json({ error: 'Could not generate explanation: ' + err.message });
  }
};
