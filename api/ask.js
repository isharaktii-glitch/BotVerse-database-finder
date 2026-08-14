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

  const { action, question, conversationId } = req.body;
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
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    // -------------------------------------------------------------
    // FEATURE 2 & 3: AUTOMATED KEY INSIGHTS GENERATION
    // -------------------------------------------------------------
    if (action === 'get_insights') {
      const contextText = JSON.stringify(businessData).slice(0, 15000);
      const insightPrompt = `Analyze this business data and extract 3 KEY INSIGHTS:
1. Top Performing Item / Highest Revenue area
2. Key Trend / Growth pattern
3. Potential Business Risk or Area of Improvement

Data:
${contextText}

Respond ONLY with JSON in this exact structure:
{
  "insights": [
    { "id": "top_product", "type": "success", "title": "Top Product / Feature", "summary": "Short 1-sentence summary", "detail": "Detailed breakdown explaining why it's performing well and exact metrics." },
    { "id": "trend", "type": "info", "title": "Key Business Trend", "summary": "Short 1-sentence summary", "detail": "Detailed explanation of the trend observed over time." },
    { "id": "risk", "type": "warning", "title": "Identified Risk / Warning", "summary": "Short 1-sentence summary", "detail": "Detailed explanation of the potential risk and mitigation advice." }
  ]
}
DO NOT INCLUDE MARKDOWN CODE FENCES. OUTPUT ONLY CLEAN JSON.`;

      const result = await model.generateContent(insightPrompt);
      let rawText = result.response.text().trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
      
      let parsed;
      try {
        parsed = JSON.parse(rawText);
      } catch(e) {
        return res.status(500).json({ error: 'Failed to parse insights JSON' });
      }

      return res.status(200).json({ success: true, insights: parsed.insights });
    }

    // -------------------------------------------------------------
    // FEATURE 1: ASK QUESTION (WITH MARKDOWN TABLES & CHARTS)
    // -------------------------------------------------------------
    if (!question) return res.status(400).json({ error: 'Question required' });

    let contextText;
    if (businessData && businessData.type === 'website') {
      contextText = `Website content from ${businessData.url}:\n\n${businessData.content}`;
    } else {
      contextText = JSON.stringify(businessData).slice(0, 15000);
    }

    const askPrompt = `You are an expert business data assistant. The user connected a data source called "${dataName}" with this content:

${contextText}

User's question: "${question}"

Respond based on these rules:
1. CHART REQUEST: If the user explicitly asks for a chart, graph, or visual rendering, respond ONLY with JSON in this format:
{"isChart": true, "chartType": "bar", "title": "Chart title", "labels": ["Label1", "Label2"], "datasets": [{"label": "Series Name", "data": [100, 200]}]}
(Use "bar" for comparisons, "line" for trends, "pie" for proportions. Max 8 labels).

2. TABULAR / COMPARISON REQUEST: If the user asks for tabular data, comparisons (e.g., "income vs expenses", "monthly breakdown"), or formatted lists, format the "answer" field using clean **Markdown Tables** (| Header1 | Header2 |).

3. REGULAR QUESTION: Clear plain text answer (3-4 sentences max).

JSON OUTPUT FORMAT FOR TEXT/TABLE ANSWERS:
{"isChart": false, "answer": "Your answer string here"}

OUTPUT ONLY VALID JSON ON A SINGLE LINE. NO MARKDOWN CODE FENCES. WRITE IN THE SAME LANGUAGE AS THE USER'S QUESTION.`;

    const result = await model.generateContent(askPrompt);
    let rawText = result.response.text().trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (parseErr) {
      parsed = { isChart: false, answer: rawText };
    }

    const historyText = parsed.isChart ? ('[Chart] ' + parsed.title) : parsed.answer;
    await pool.query(
      'INSERT INTO chat_history (user_id, question, answer, conversation_id) VALUES ($1, $2, $3, $4)',
      [decoded.userId, question, historyText, conversationId]
    );

    return res.status(200).json({ success: true, ...parsed });

  } catch (err) {
    console.error('ASK ERROR:', err.message);
    res.status(500).json({ error: 'Could not process request: ' + err.message });
  }
};
