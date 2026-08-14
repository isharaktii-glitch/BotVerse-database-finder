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
    const { conversationId } = req.query;
    if (!conversationId) return res.status(400).json({ error: 'conversationId required' });

    try {
      const result = await pool.query(
        `SELECT ch.id, ch.question, ch.answer, ch.created_at
         FROM chat_history ch
         JOIN conversations c ON c.id = ch.conversation_id
         WHERE ch.conversation_id = $1 AND c.user_id = $2
         ORDER BY ch.created_at ASC`,
        [conversationId, decoded.userId]
      );
      res.status(200).json({ messages: result.rows });
    } catch (err) {
      console.error('GET MESSAGES ERROR:', err.message);
      res.status(500).json({ error: 'Could not load messages' });
    }
    return;
  }

  if (req.method === 'DELETE') {
    const { messageId } = req.body;
    if (!messageId) return res.status(400).json({ error: 'messageId required' });

    try {
      await pool.query(
        `DELETE FROM chat_history ch
         USING conversations c
         WHERE ch.conversation_id = c.id AND ch.id = $1 AND c.user_id = $2`,
        [messageId, decoded.userId]
      );
      res.status(200).json({ success: true });
    } catch (err) {
      console.error('DELETE MESSAGE ERROR:', err.message);
      res.status(500).json({ error: 'Could not delete message' });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
