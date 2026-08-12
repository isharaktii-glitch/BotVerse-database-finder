const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });

  const token = authHeader.replace('Bearer ', '');
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  try {
    const dataResult = await pool.query(
      'SELECT data_name, data_json FROM business_data WHERE user_id = $1 ORDER BY uploaded_at DESC LIMIT 1',
      [decoded.userId]
    );

    const historyResult = await pool.query(
      'SELECT question, answer, created_at FROM chat_history WHERE user_id = $1 ORDER BY created_at ASC LIMIT 50',
      [decoded.userId]
    );

    let dataInfo = null;
    if (dataResult.rows.length > 0) {
      const row = dataResult.rows[0];
      const rowCount = Array.isArray(row.data_json) ? row.data_json.length : null;
      dataInfo = {
        dataName: row.data_name,
        label: rowCount ? (rowCount + ' rows loaded') : 'Data connected'
      };
    }

    res.status(200).json({
      hasData: !!dataInfo,
      dataInfo,
      history: historyResult.rows
    });

  } catch (err) {
    console.error('GET DASHBOARD ERROR:', err.message);
    res.status(500).json({ error: 'Could not load your dashboard data' });
  }
};
