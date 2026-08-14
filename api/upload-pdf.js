const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const pdfParse = require('pdf-parse');
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

  const { fileName, base64Data } = req.body;
  if (!fileName || !base64Data) return res.status(400).json({ error: 'File data required' });

  try {
    const pdfBuffer = Buffer.from(base64Data, 'base64');
    const pdfData = await pdfParse(pdfBuffer);
    const text = pdfData.text.slice(0, 10000);

    if (text.trim().length < 20) {
      return res.status(400).json({ error: 'Could not read text from this PDF. It may be a scanned image.' });
    }

    const model = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });
    const today = new Date().toISOString().split('T')[0];

    const prompt = `Today's date is ${today}. Analyze this document text and extract key information. Respond ONLY with valid JSON, no markdown fences, no extra text:

{"docType": "assignment|invoice|contract|other", "summary": "one sentence summary of what this document is", "deadlineDate": "YYYY-MM-DD or null if no deadline found", "priority": "high|medium|low"}

Document text:
${text}`;

    const result = await model.generateContent(prompt);
    let rawText = result.response.text().trim();
    rawText = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (e) {
      parsed = { docType: 'other', summary: 'Could not analyze document details.', deadlineDate: null, priority: 'low' };
    }

    const convResult = await pool.query(
      'INSERT INTO conversations (user_id, title, source_type) VALUES ($1, $2, $3) RETURNING id',
      [decoded.userId, fileName, 'document']
    );
    const conversationId = convResult.rows[0].id;

    await pool.query(
      'INSERT INTO documents (user_id, file_name, doc_type, extracted_summary, deadline_date, priority) VALUES ($1, $2, $3, $4, $5, $6)',
      [decoded.userId, fileName, parsed.docType, parsed.summary, parsed.deadlineDate, parsed.priority]
    );

    await pool.query(
      'INSERT INTO business_data (user_id, data_name, data_json, conversation_id) VALUES ($1, $2, $3, $4)',
      [decoded.userId, fileName, JSON.stringify({ type: 'document', text: text.slice(0, 8000), summary: parsed.summary }), conversationId]
    );

    res.status(200).json({ success: true, ...parsed, conversationId });

  } catch (err) {
    console.error('PDF UPLOAD ERROR:', err.message);
    res.status(500).json({ error: 'Could not process that PDF: ' + err.message });
  }
};
