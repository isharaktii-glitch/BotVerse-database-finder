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

  const { sheetUrl } = req.body;
  if (!sheetUrl) return res.status(400).json({ error: 'Google Sheet URL required' });

  const match = sheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
  if (!match) return res.status(400).json({ error: 'That does not look like a valid Google Sheets link.' });
  const sheetId = match[1];
  const csvExportUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;

  try {
    const response = await fetch(csvExportUrl, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return res.status(400).json({ error: 'Could not access that sheet. Make sure sharing is set to "Anyone with the link can view".' });

    const csvText = await response.text();
    if (csvText.trim().startsWith('<!DOCTYPE') || csvText.trim().startsWith('<html')) {
      return res.status(400).json({ error: 'Could not access that sheet. Make sure sharing is set to "Anyone with the link can view".' });
    }

    const rows = csvText.split('\n').filter(r => r.trim());
    if (rows.length < 2) return res.status(400).json({ error: 'This sheet appears to be empty.' });

    const headers = rows[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    const data = rows.slice(1).map(row => {
      const values = row.split(',');
      const obj = {};
      headers.forEach((h, i) => { obj[h] = values[i] ? values[i].trim().replace(/^"|"$/g, '') : ''; });
      return obj;
    });

    if (data.length > 2000) return res.status(400).json({ error: 'Sheet too large. Please limit to 2000 rows.' });

    const convResult = await pool.query(
      'INSERT INTO conversations (user_id, title, source_type) VALUES ($1, $2, $3) RETURNING id',
      [decoded.userId, 'Google Sheet', 'sheet']
    );
    const conversationId = convResult.rows[0].id;

    await pool.query(
      'INSERT INTO business_data (user_id, data_name, data_json, conversation_id) VALUES ($1, $2, $3, $4)',
      [decoded.userId, 'Google Sheet', JSON.stringify(data), conversationId]
    );

    res.status(200).json({ success: true, rowCount: data.length, conversationId });

  } catch (err) {
    console.error('SHEET FETCH ERROR:', err.message);
    res.status(500).json({ error: 'Could not read that sheet. Please check the link and try again.' });
  }
};
