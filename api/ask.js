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

  const { question } = req.body;
  if (!question) return res.status(400).json({ error: 'Question required' });

  try {
    const dataResult = await pool.query(
      'SELECT data_json, data_name FROM business_data WHERE user_id = $1 ORDER BY uploaded_at DESC LIMIT 1',
      [decoded.userId]
    );

    if (dataResult.rows.length === 0) {
      return res.status(400).json({ error: 'Please upload your business data first.' });
    }

    const businessData = dataResult.rows[0].data_json;
    const dataName = dataResult.rows[0].data_name;

    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const prompt = `You are a business data assistant. The user uploaded a file called "${dataName}" with this data (JSON array of rows):

${JSON.stringify(businessData).slice(0, 15000)}

The user's question: "${question}"

Analyze the data and answer the question directly and concisely, in the same language the question was asked in (Sinhala or English). If the answer requires a calculation (sum, average, count, etc.), do the calculation accurately based on the actual data shown above. If the data doesn't contain information to answer the question, say so clearly. Keep the answer short and business-friendly, no more than 3-4 sentences.`;

    const result = await model.generateContent(prompt);
    const answer = result.response.text();

    await pool.query(
      'INSERT INTO chat_history (user_id, question, answer) VALUES ($1, $2, $3)',
      [decoded.userId, question, answer]
    );

    res.status(200).json({ success: true, answer });

  } catch (err) {
    console.error('ASK ERROR:', err.message);
    res.status(500).json({ error: 'Could not process your question: ' + err.message });
  }
};
