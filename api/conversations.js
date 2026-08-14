const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function verifyToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  const token = authHeader.replace('Bearer ', '');
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return null;
  }
}

module.exports = async (req, res) => {
  const decoded = verifyToken(req);
  if (!decoded) return res.status(401).json({ error: 'Invalid or expired token' });

  if (req.method === 'GET') {
    const { date } = req.query;
    try {
      let query = `
        SELECT c.id, c.title, c.source_type, c.created_at,
          (SELECT COUNT(*) FROM chat_history WHERE conversation_id = c.id) as message_count
        FROM conversations c
        WHERE c.user_id = $1
      `;
      const params = [decoded.userId];

      if (date) {
        query += ` AND DATE(c.created_at) = $2`;
        params.push(date);
      }
      query += ` ORDER BY c.created_at DESC`;

      const result = await pool.query(query, params);
      res.status(200).json({ conversations: result.rows });
    } catch (err) {
      console.error('LIST CONVERSATIONS ERROR:', err.message);
      res.status(500).json({ error: 'Could not load conversations' });
    }
    return;
  }

  if (req.method === 'DELETE') {
    const { conversationId, beforeDate } = req.body;

    try {
      if (conversationId) {
        await pool.query('DELETE FROM conversations WHERE id = $1 AND user_id = $2', [conversationId, decoded.userId]);
        return res.status(200).json({ success: true });
      }

      if (beforeDate) {
        const result = await pool.query(
          'DELETE FROM conversations WHERE user_id = $1 AND created_at <= $2 RETURNING id',
          [decoded.userId, beforeDate]
        );
        return res.status(200).json({ success: true, deletedCount: result.rows.length });
      }

      return res.status(400).json({ error: 'conversationId or beforeDate required' });
    } catch (err) {
      console.error('DELETE CONVERSATION ERROR:', err.message);
      res.status(500).json({ error: 'Could not delete conversation' });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
