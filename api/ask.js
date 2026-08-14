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

  const { question, conversationId } = req.body;
  if (!question) return res.status(400).json({ error: 'Question required' });
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

    const prompt = `You are a business data assistant. The user connected a data source called "${dataName}" with this content:

${contextText}

The user's question: "${question}"

Decide the BEST way to answer based on what the user is actually asking. Respond ONLY with valid JSON, no markdown fences, no extra text, using this exact structure:

{
  "answer": "A short, clear explanation in 2-4 sentences, in the same language as the question.",
  "includeTable": true or false,
  "table": { "headers": ["Col1", "Col2"], "rows": [["val1", "val2"], ["val3", "val4"]] } or null,
  "includeChart": true or false,
  "chart": { "chartType": "bar|line|pie", "title": "Chart title", "labels": ["Label1", "Label2"], "datasets": [{"label": "Series name", "data": [123, 456]}] } or null
}

Rules for deciding format:
- If the question asks for a comparison, breakdown, or list of multiple items (e.g. "top products", "daily income and expenses", "sales by category") → set includeTable to true with clean, well-organized rows. Use at most 10 rows unless the user asks for more.
- If the question implies a visual trend or comparison would help (e.g. "compare X and Y", "show me the trend", "which is highest") → set includeChart to true.
- If the question is a simple factual question with one answer (e.g. "what was my total revenue", "how many customers do I have") → set both includeTable and includeChart to false, just answer in the "answer" field.
- Never include a table AND chart both unless the question truly needs both to be understood.
- Calculate all values accurately based on the actual data shown above.
- Table headers and chart labels must be in the same language as the question.
- Use at most 8 labels/rows in charts to keep them readable.

Respond with ONLY the JSON object, nothing else, no markdown code fences.`;

    const result = await model.generateContent(prompt);
    let rawText = result.response.text().trim();
    rawText = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (parseErr) {
      parsed = { answer: rawText, includeTable: false, table: null, includeChart: false, chart: null };
    }

    // Safety defaults in case AI omits fields
    if (typeof parsed.includeTable !== 'boolean') parsed.includeTable = false;
    if (typeof parsed.includeChart !== 'boolean') parsed.includeChart = false;
    if (!parsed.answer) parsed.answer = '';

    const historyText = parsed.answer || (parsed.includeChart ? '[Chart] ' + (parsed.chart && parsed.chart.title) : 'Answered');
    await pool.query(
      'INSERT INTO chat_history (user_id, question, answer, conversation_id) VALUES ($1, $2, $3, $4)',
      [decoded.userId, question, historyText, conversationId]
    );

    res.status(200).json({ success: true, ...parsed });

  } catch (err) {
    console.error('ASK ERROR:', err.message);
    res.status(500).json({ error: 'Could not process your question: ' + err.message });
  }
};
