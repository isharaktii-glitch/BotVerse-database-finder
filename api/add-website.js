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

  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Website URL required' });

  let validUrl;
  try {
    validUrl = new URL(url);
    if (!['http:', 'https:'].includes(validUrl.protocol)) throw new Error('Invalid protocol');
  } catch (err) {
    return res.status(400).json({ error: 'Please enter a valid website URL (starting with http:// or https://)' });
  }

  try {
    const response = await fetch(validUrl.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BotVerseBot/1.0)' },
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) return res.status(400).json({ error: 'Could not access that website. It may be blocking automated access.' });

    const html = await response.text();
    const textContent = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 12000);

    if (textContent.length < 50) return res.status(400).json({ error: 'This page has little readable text. It may require JavaScript to load content.' });

    const convResult = await pool.query(
      'INSERT INTO conversations (user_id, title, source_type) VALUES ($1, $2, $3) RETURNING id',
      [decoded.userId, 'Website: ' + validUrl.hostname, 'website']
    );
    const conversationId = convResult.rows[0].id;

    await pool.query(
      'INSERT INTO business_data (user_id, data_name, data_json, conversation_id) VALUES ($1, $2, $3, $4)',
      [decoded.userId, 'Website: ' + validUrl.hostname, JSON.stringify({ type: 'website', url: validUrl.toString(), content: textContent }), conversationId]
    );

    res.status(200).json({ success: true, charCount: textContent.length, conversationId });

  } catch (err) {
    console.error('WEBSITE FETCH ERROR:', err.message);
    res.status(500).json({ error: 'Could not read that website. Please check the link and try again.' });
  }
};
