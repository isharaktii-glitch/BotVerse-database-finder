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

  const { conversationId } = req.body;
  if (!conversationId) return res.status(400).json({ error: 'conversationId required' });

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

    const prompt = `You are a business data analyst. Analyze this data source called "${dataName}":

${contextText}

Find 2-3 genuinely notable, specific insights a business owner would want to know about — things like unusual spikes, a dominant product/category, a concerning trend, a strong performer, or an outlier. Be specific with numbers. Avoid generic statements.

Respond ONLY with valid JSON, no markdown fences, no extra text, using this exact structure:

{
  "highlights": [
    {
      "id": "short-slug-1",
      "icon": "one relevant emoji",
      "title": "Short punchy title (max 6 words)",
      "shortDesc": "One sentence summary, max 20 words"
    }
  ]
}

Write in the same language the data itself is in, or English if unclear. If the data genuinely has nothing notable (too small, too generic), return an empty highlights array.`;

    const result = await model.generateContent(prompt);
    let rawText = result.response.text().trim();
    rawText = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (e) {
      parsed = { highlights: [] };
    }

    if (!Array.isArray(parsed.highlights)) parsed.highlights = [];

    res.status(200).json({ success: true, highlights: parsed.highlights });

  } catch (err) {
    console.error('HIGHLIGHTS ERROR:', err.message);
    res.status(500).json({ error: 'Could not generate highlights: ' + err.message });
  }
};
