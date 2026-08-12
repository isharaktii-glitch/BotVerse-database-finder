const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

module.exports = async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });

  const token = authHeader.replace('Bearer ', '');
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  if (req.method === 'GET') {
    try {
      const result = await pool.query(
        'SELECT enabled, notify_email, days_before_deadline FROM notification_settings WHERE user_id = $1',
        [decoded.userId]
      );
      if (result.rows.length === 0) {
        return res.status(200).json({ enabled: false, notify_email: '', days_before_deadline: 3 });
      }
      res.status(200).json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: 'Server error' });
    }
    return;
  }

  if (req.method === 'POST') {
    const { enabled, notifyEmail, daysBeforeDeadline } = req.body;

    try {
      await pool.query(`
        INSERT INTO notification_settings (user_id, enabled, notify_email, days_before_deadline)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (user_id) DO UPDATE SET
          enabled = $2, notify_email = $3, days_before_deadline = $4
      `, [decoded.userId, enabled, notifyEmail, daysBeforeDeadline || 3]);

      res.status(200).json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Could not save settings' });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
