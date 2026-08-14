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

    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    let contextText;
    if (businessData && businessData.type === 'website') {
      contextText = `Website content from ${businessData.url}:\n\n${businessData.content}`;
    } else {
      contextText = JSON.stringify(businessData).slice(0, 15000);
    }

    const prompt = `You are an expert business data assistant. The user connected a data source called "${dataName}" with this content:

${contextText}

User's question: "${question}"

Respond based on these rules:

1. CHART REQUEST: If the user explicitly asks for a chart, graph, or visual rendering, respond ONLY with JSON in this format:
{"isChart": true, "chartType": "bar", "title": "Chart title", "labels": ["Label1", "Label2"], "datasets": [{"label": "Series Name", "data": [100, 200]}]}
(Use "bar" for comparisons, "line" for trends, "pie" for proportions. Max 8 labels).

2. TABULAR / COMPARISON REQUEST: If the user is asking for tabular data, comparisons (e.g., "income vs expenses", "monthly breakdown", "product comparison"), formatted lists, or structured financial numbers, format the "answer" field using clean **Markdown Tables** (| Header1 | Header2 |).

3. REGULAR QUESTION: Provide a clear, concise plain text answer (3-4 sentences max).

JSON OUTPUT FORMAT FOR TEXT/TABLE ANSWERS:
{"isChart": false, "answer": "Your answer string here (use markdown tables inside this string ONLY if the question requires tabular/comparative data)"}

OUTPUT ONLY VALID JSON ON A SINGLE LINE. NO MARKDOWN CODE FENCES (no \`\`\`json). WRITE IN THE SAME LANGUAGE AS THE USER'S QUESTION.`;

    const result = await model.generateContent(prompt);
    let rawText = result.response.text().trim();
    rawText = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

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

    res.status(200).json({ success: true, ...parsed });

  } catch (err) {
    console.error('ASK ERROR:', err.message);
    res.status(500).json({ error: 'Could not process your question: ' + err.message });
  }
};
