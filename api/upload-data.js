const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

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

  const { dataName, data } = req.body;

  if (!dataName || !data || !Array.isArray(data)) {
    return res.status(400).json({ error: 'dataName and data array required' });
  }

  if (data.length > 2000) {
    return res.status(400).json({ error: 'File too large. Please limit to 2000 rows.' });
  }

  try {
    const convResult = await pool.query(
      'INSERT INTO conversations (user_id, title, source_type) VALUES ($1, $2, $3) RETURNING id',
      [decoded.userId, dataName, 'file']
    );
    const conversationId = convResult.rows[0].id;

    await pool.query(
      'INSERT INTO business_data (user_id, data_name, data_json, conversation_id) VALUES ($1, $2, $3, $4)',
      [decoded.userId, dataName, JSON.stringify(data), conversationId]
    );

    res.status(200).json({ success: true, rowCount: data.length, conversationId });
  } catch (err) {
    console.error('UPLOAD DATA ERROR:', err.message);
    res.status(500).json({ error: 'Server error while saving data' });
  }
};
