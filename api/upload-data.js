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
    await pool.query('DELETE FROM business_data WHERE user_id = $1', [decoded.userId]);

    await pool.query(
      'INSERT INTO business_data (user_id, data_name, data_json) VALUES ($1, $2, $3)',
      [decoded.userId, dataName, JSON.stringify(data)]
    );

    res.status(200).json({ success: true, rowCount: data.length });
  } catch (err) {
    res.status(500).json({ error: 'Server error while saving data' });
  }
};
