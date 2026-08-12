const { Pool } = require('pg');
const { Resend } = require('resend');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const resend = new Resend(process.env.RESEND_API_KEY);

module.exports = async (req, res) => {
  const authHeader = req.headers.authorization;
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const usersResult = await pool.query(`
      SELECT ns.user_id, ns.notify_email, ns.days_before_deadline, u.business_name
      FROM notification_settings ns
      JOIN users u ON u.id = ns.user_id
      WHERE ns.enabled = true AND ns.notify_email IS NOT NULL
    `);

    let emailsSent = 0;

    for (const setting of usersResult.rows) {
      const docsResult = await pool.query(`
        SELECT d.id, d.file_name, d.doc_type, d.extracted_summary, d.deadline_date, d.priority
        FROM documents d
        WHERE d.user_id = $1
          AND d.deadline_date IS NOT NULL
          AND d.deadline_date <= CURRENT_DATE + ($2 || ' days')::INTERVAL
          AND d.deadline_date >= CURRENT_DATE
          AND d.id NOT IN (SELECT document_id FROM notifications_sent WHERE user_id = $1)
      `, [setting.user_id, setting.days_before_deadline]);

      if (docsResult.rows.length === 0) continue;

      const itemsList = docsResult.rows.map(d =>
        `• ${d.file_name} (${d.doc_type}) — due ${d.deadline_date} — ${d.summary || d.extracted_summary}`
      ).join('\n');

      try {
        await resend.emails.send({
          from: 'BotVerse <onboarding@resend.dev>',
          to: setting.notify_email,
          subject: `${setting.business_name}: Upcoming deadlines`,
          text: `Hi,\n\nYou have upcoming deadlines:\n\n${itemsList}\n\n— BotVerse`
        });

        for (const doc of docsResult.rows) {
          await pool.query(
            'INSERT INTO notifications_sent (user_id, document_id) VALUES ($1, $2)',
            [setting.user_id, doc.id]
          );
        }
        emailsSent++;
      } catch (emailErr) {
        console.error('Email send error for user', setting.user_id, emailErr.message);
      }
    }

    res.status(200).json({ success: true, emailsSent });

  } catch (err) {
    console.error('CRON ERROR:', err.message);
    res.status(500).json({ error: err.message });
  }
};
