const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 4000;

// PostgreSQL connection
const pool = new Pool({
  host: process.env.DB_HOST || 'postgres',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'attendance',
  user: process.env.DB_USER || 'admin',
  password: process.env.DB_PASSWORD || 'attendance123',
});

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*' }));
app.use(morgan('combined'));
app.use(express.json());

// Serve static frontend files (frontend/ is copied into /app/frontend inside container)
app.use('/checkin', express.static(path.join(__dirname, 'frontend/checkin')));
app.use('/admin', express.static(path.join(__dirname, 'frontend/admin')));
app.get('/', (req, res) => res.redirect('/admin'));

// ─────────────────────────────────────────
// DB INIT
// ─────────────────────────────────────────
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS employees (
        id SERIAL PRIMARY KEY,
        phone VARCHAR(20) UNIQUE NOT NULL,
        name VARCHAR(100) NOT NULL,
        employee_id VARCHAR(50) UNIQUE NOT NULL,
        department VARCHAR(100),
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS checkin_tokens (
        id SERIAL PRIMARY KEY,
        token VARCHAR(64) UNIQUE NOT NULL,
        phone VARCHAR(20) NOT NULL,
        action VARCHAR(10) NOT NULL,  -- 'in' or 'out'
        expires_at TIMESTAMP NOT NULL,
        used BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS attendance (
        id SERIAL PRIMARY KEY,
        employee_id VARCHAR(50) NOT NULL,
        phone VARCHAR(20) NOT NULL,
        action VARCHAR(10) NOT NULL,
        latitude DECIMAL(10, 8),
        longitude DECIMAL(11, 8),
        ip_address VARCHAR(45),
        device_info TEXT,
        selfie_url TEXT,
        within_geofence BOOLEAN,
        timestamp TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS office_locations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        latitude DECIMAL(10, 8) NOT NULL,
        longitude DECIMAL(11, 8) NOT NULL,
        radius_meters INTEGER DEFAULT 200,
        active BOOLEAN DEFAULT TRUE
      );

      -- Insert default office location if not exists
      INSERT INTO office_locations (name, latitude, longitude, radius_meters)
      VALUES ('Main Office', 12.9716, 77.5946, 200)
      ON CONFLICT DO NOTHING;

      -- Insert sample employees if not exists
      INSERT INTO employees (phone, name, employee_id, department)
      VALUES
        ('919876543210', 'Rahul Sharma', 'EMP001', 'Engineering'),
        ('919876543211', 'Priya Patel', 'EMP002', 'HR'),
        ('919876543212', 'Amit Verma', 'EMP003', 'Sales')
      ON CONFLICT DO NOTHING;
    `);
    console.log('✅ Database initialized');
  } catch (err) {
    console.error('DB init error:', err.message);
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────
// WHATSAPP WEBHOOK (called by n8n)
// ─────────────────────────────────────────
app.post('/api/whatsapp/webhook', async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });

    const normalizedPhone = phone.replace(/\D/g, '');
    const text = message.trim().toLowerCase();

    let action = null;
    if (['check in', 'checkin', 'in', 'mark in', '1'].includes(text)) action = 'in';
    else if (['check out', 'checkout', 'out', 'mark out', '2'].includes(text)) action = 'out';

    if (!action) {
      return res.json({
        reply: `👋 Welcome to Smart Attendance!\n\nSend:\n✅ *Check In* — to mark your arrival\n🚪 *Check Out* — to mark your departure\n\nNeed help? Contact HR.`
      });
    }

    // Verify employee
    const empResult = await pool.query('SELECT * FROM employees WHERE phone = $1 AND active = TRUE', [normalizedPhone]);
    if (empResult.rows.length === 0) {
      return res.json({ reply: `❌ Your number (${phone}) is not registered in our system.\n\nPlease contact HR to get registered.` });
    }

    const employee = empResult.rows[0];

    // Check for duplicate same-day action
    const dupCheck = await pool.query(
      `SELECT * FROM attendance WHERE phone = $1 AND action = $2 AND DATE(timestamp) = CURRENT_DATE`,
      [normalizedPhone, action]
    );
    if (dupCheck.rows.length > 0) {
      const lastTime = new Date(dupCheck.rows[0].timestamp).toLocaleTimeString('en-IN');
      return res.json({
        reply: `⚠️ You already marked *${action === 'in' ? 'Check In' : 'Check Out'}* today at ${lastTime}.\n\nIf this is an error, contact HR.`
      });
    }

    // Generate secure token (expires in 5 minutes)
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    await pool.query(
      'INSERT INTO checkin_tokens (token, phone, action, expires_at) VALUES ($1, $2, $3, $4)',
      [token, normalizedPhone, action, expiresAt]
    );

    const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
    const link = `${baseUrl}/checkin?token=${token}`;
    const actionWord = action === 'in' ? 'Check In ✅' : 'Check Out 🚪';

    return res.json({
      reply: `Hi *${employee.name}*! 👋\n\n🔗 Click below to complete your *${actionWord}*:\n\n${link}\n\n⏳ Link expires in *5 minutes*.\n📍 Please allow location access when prompted.`,
      employee: employee.name,
      action
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// VALIDATE TOKEN (called by check-in page)
// ─────────────────────────────────────────
app.get('/api/token/validate', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ valid: false, error: 'No token' });

  try {
    const result = await pool.query(
      'SELECT t.*, e.name, e.employee_id, e.department FROM checkin_tokens t JOIN employees e ON t.phone = e.phone WHERE t.token = $1',
      [token]
    );

    if (result.rows.length === 0) return res.json({ valid: false, error: 'Invalid link' });

    const row = result.rows[0];
    if (row.used) return res.json({ valid: false, error: 'This link has already been used' });
    if (new Date() > new Date(row.expires_at)) return res.json({ valid: false, error: 'Link has expired. Please request a new one via WhatsApp.' });

    res.json({ valid: true, action: row.action, name: row.name, employee_id: row.employee_id, department: row.department });
  } catch (err) {
    res.status(500).json({ valid: false, error: err.message });
  }
});

// ─────────────────────────────────────────
// SUBMIT ATTENDANCE
// ─────────────────────────────────────────
app.post('/api/attendance/submit', async (req, res) => {
  const { token, latitude, longitude, deviceInfo, selfieUrl } = req.body;
  if (!token) return res.status(400).json({ success: false, error: 'Token required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const tokenResult = await client.query(
      'SELECT t.*, e.name, e.employee_id FROM checkin_tokens t JOIN employees e ON t.phone = e.phone WHERE t.token = $1 FOR UPDATE',
      [token]
    );

    if (tokenResult.rows.length === 0) throw new Error('Invalid token');
    const tok = tokenResult.rows[0];
    if (tok.used) throw new Error('Token already used');
    if (new Date() > new Date(tok.expires_at)) throw new Error('Token expired');

    // Geofence check
    let withinGeofence = null;
    let geofenceMessage = '';
    if (latitude && longitude) {
      const officeResult = await client.query('SELECT * FROM office_locations WHERE active = TRUE LIMIT 1');
      if (officeResult.rows.length > 0) {
        const office = officeResult.rows[0];
        const distance = haversine(parseFloat(latitude), parseFloat(longitude), parseFloat(office.latitude), parseFloat(office.longitude));
        withinGeofence = distance <= office.radius_meters;
        geofenceMessage = withinGeofence
          ? `📍 Location verified (${Math.round(distance)}m from office)`
          : `⚠️ Outside office zone (${Math.round(distance)}m away — allowed: ${office.radius_meters}m)`;
      }
    }

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    // Save attendance
    await client.query(
      `INSERT INTO attendance (employee_id, phone, action, latitude, longitude, ip_address, device_info, selfie_url, within_geofence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [tok.employee_id, tok.phone, tok.action, latitude || null, longitude || null, ip, deviceInfo || null, selfieUrl || null, withinGeofence]
    );

    // Mark token used
    await client.query('UPDATE checkin_tokens SET used = TRUE WHERE token = $1', [token]);

    await client.query('COMMIT');

    res.json({
      success: true,
      action: tok.action,
      name: tok.name,
      employee_id: tok.employee_id,
      timestamp: new Date().toISOString(),
      withinGeofence,
      geofenceMessage
    });

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────
// ADMIN API
// ─────────────────────────────────────────
app.get('/api/admin/attendance', async (req, res) => {
  const { date, employee_id } = req.query;
  let query = `
    SELECT a.*, e.name, e.department
    FROM attendance a
    JOIN employees e ON a.employee_id = e.employee_id
    WHERE 1=1
  `;
  const params = [];

  if (date) { params.push(date); query += ` AND DATE(a.timestamp) = $${params.length}`; }
  if (employee_id) { params.push(employee_id); query += ` AND a.employee_id = $${params.length}`; }

  query += ' ORDER BY a.timestamp DESC LIMIT 200';

  try {
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/summary', async (req, res) => {
  const { date } = req.query;
  const targetDate = date || new Date().toISOString().split('T')[0];

  try {
    const result = await pool.query(`
      SELECT
        e.employee_id, e.name, e.department,
        MAX(CASE WHEN a.action = 'in' THEN a.timestamp END) as check_in,
        MAX(CASE WHEN a.action = 'out' THEN a.timestamp END) as check_out,
        BOOL_OR(CASE WHEN a.within_geofence = FALSE THEN TRUE ELSE FALSE END) as flagged
      FROM employees e
      LEFT JOIN attendance a ON e.employee_id = a.employee_id AND DATE(a.timestamp) = $1
      WHERE e.active = TRUE
      GROUP BY e.employee_id, e.name, e.department
      ORDER BY e.name
    `, [targetDate]);

    const stats = {
      total: result.rows.length,
      present: result.rows.filter(r => r.check_in).length,
      absent: result.rows.filter(r => !r.check_in).length,
      checkedOut: result.rows.filter(r => r.check_out).length,
      flagged: result.rows.filter(r => r.flagged).length,
    };

    res.json({ date: targetDate, stats, employees: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/employees', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM employees ORDER BY name');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/employees', async (req, res) => {
  const { phone, name, employee_id, department } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO employees (phone, name, employee_id, department) VALUES ($1, $2, $3, $4) RETURNING *',
      [phone.replace(/\D/g, ''), name, employee_id, department]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/admin/office', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM office_locations WHERE active = TRUE LIMIT 1');
    res.json(result.rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/office', async (req, res) => {
  const { latitude, longitude, radius_meters, name } = req.body;
  try {
    await pool.query('UPDATE office_locations SET active = FALSE');
    const result = await pool.query(
      'INSERT INTO office_locations (name, latitude, longitude, radius_meters) VALUES ($1, $2, $3, $4) RETURNING *',
      [name || 'Main Office', latitude, longitude, radius_meters || 200]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// UTILITY
// ─────────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180, Δλ = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

// ─────────────────────────────────────────
// START
// ─────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`🚀 Attendance Server running on port ${PORT}`);
  await new Promise(r => setTimeout(r, 3000)); // wait for postgres
  await initDB();
});
