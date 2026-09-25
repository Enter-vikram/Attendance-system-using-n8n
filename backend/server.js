const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 4000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ── Required secrets — fail fast if missing ──────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!ADMIN_PASSWORD) { console.error('FATAL: ADMIN_PASSWORD is not set'); process.exit(1); }
if (!SESSION_SECRET) { console.error('FATAL: SESSION_SECRET is not set'); process.exit(1); }

// ── PostgreSQL ────────────────────────────────────────────────────────────────
// DATABASE_URL is authoritative (Railway, Heroku, Render, etc.).
// Individual DB_* vars are used only when DATABASE_URL is absent (local Docker).
let poolConfig;
if (process.env.DATABASE_URL) {
  const dbUrl = new URL(process.env.DATABASE_URL);
  poolConfig = {
    connectionString: process.env.DATABASE_URL,
    // Railway Postgres requires TLS; rejectUnauthorized:false accepts the
    // self-signed cert that Railway uses on internal connections.
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  };
  console.log(
    `🔌 DB config source: DATABASE_URL` +
    ` | host=${dbUrl.hostname}` +
    ` | db=${dbUrl.pathname.slice(1)}` +
    ` | user=${dbUrl.username}`
  );
} else {
  poolConfig = {
    host:     process.env.DB_HOST || 'postgres',
    port:     parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'attendance',
    user:     process.env.DB_USER || 'admin',
    password: process.env.DB_PASSWORD,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  };
  console.log(
    `🔌 DB config source: individual vars` +
    ` | host=${poolConfig.host}` +
    ` | db=${poolConfig.database}` +
    ` | user=${poolConfig.user}`
  );
}
const pool = new Pool(poolConfig);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],
      styleSrc:   ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:    ["'self'", 'https://fonts.gstatic.com'],
      imgSrc:     ["'self'", 'data:'],
      connectSrc: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

const allowedOrigin = new URL(BASE_URL).origin;
app.use(cors({
  origin: allowedOrigin,
  credentials: true,                          // required for session cookies
  methods: ['GET', 'POST', 'PUT'],
  allowedHeaders: ['Content-Type'],           // no custom auth header needed
}));

app.use(morgan('combined'));
app.use(express.json({ limit: '2mb' }));

// COOKIE_SECURE=true only when served over HTTPS (set explicitly in production)
// Decoupled from NODE_ENV so local HTTP testing works even with NODE_ENV=production
const cookieSecure = process.env.COOKIE_SECURE === 'true';
app.use(session({
  store: new pgSession({
    pool,
    tableName: 'session',
    createTableIfMissing: true,
  }),
  secret: SESSION_SECRET,
  name: 'attend.sid',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,                           // never readable by JS
    secure: cookieSecure,                     // true only when HTTPS is confirmed
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000,              // 8-hour session
  },
}));

// ── Rate limiters ─────────────────────────────────────────────────────────────
const checkinLimiter = rateLimit({ windowMs: 60_000, max: 10,  standardHeaders: true, legacyHeaders: false });
const webhookLimiter = rateLimit({ windowMs: 60_000, max: 30,  standardHeaders: true, legacyHeaders: false });
const adminLimiter   = rateLimit({ windowMs: 60_000, max: 60,  standardHeaders: true, legacyHeaders: false });
const loginLimiter   = rateLimit({ windowMs: 60_000, max: 10,  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in a minute.' } });

// ── Admin session middleware ──────────────────────────────────────────────────
function requireAdminSession(req, res, next) {
  if (req.session?.isAdmin === true) return next();
  res.status(401).json({ error: 'Unauthorized — please log in at /admin' });
}

// ── Static files ──────────────────────────────────────────────────────────────
app.use('/checkin', express.static(path.join(__dirname, 'frontend/checkin')));
app.use('/admin',   express.static(path.join(__dirname, 'frontend/admin')));
app.get('/', (req, res) => res.redirect('/admin'));

// ── DB Init ───────────────────────────────────────────────────────────────────
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
        action VARCHAR(10) NOT NULL,
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

      INSERT INTO office_locations (name, latitude, longitude, radius_meters)
      VALUES ('Main Office', 12.9716, 77.5946, 200)
      ON CONFLICT DO NOTHING;

      INSERT INTO employees (phone, name, employee_id, department)
      VALUES
        ('919876543210', 'Rahul Sharma', 'EMP001', 'Engineering'),
        ('919876543211', 'Priya Patel',  'EMP002', 'HR'),
        ('919876543212', 'Amit Verma',   'EMP003', 'Sales')
      ON CONFLICT DO NOTHING;
    `);
    console.log('✅ Database initialized');
  } catch (err) {
    console.error('DB init error:', err.message);
  } finally {
    client.release();
  }
}

// ── Admin Auth ────────────────────────────────────────────────────────────────

// POST /api/admin/login  { password }
app.post('/api/admin/login', loginLimiter, (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });

  // Constant-time comparison to prevent timing attacks
  const provided = Buffer.from(String(password));
  const expected = Buffer.from(ADMIN_PASSWORD);
  const match = provided.length === expected.length &&
    crypto.timingSafeEqual(provided, expected);

  if (!match) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Session error' });
    req.session.isAdmin = true;
    res.json({ ok: true });
  });
});

// POST /api/admin/logout
app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('attend.sid');
    res.json({ ok: true });
  });
});

// GET /api/admin/me  — lets the frontend check if already logged in
app.get('/api/admin/me', (req, res) => {
  res.json({ authenticated: req.session?.isAdmin === true });
});

// ── WhatsApp Webhook (called by n8n) ─────────────────────────────────────────
app.post('/api/whatsapp/webhook', webhookLimiter, async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });

    const normalizedPhone = phone.replace(/\D/g, '');
    if (normalizedPhone.length < 7 || normalizedPhone.length > 15) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }
    const text = message.trim().toLowerCase();

    let action = null;
    if (['check in', 'checkin', 'in', 'mark in', '1'].includes(text)) action = 'in';
    else if (['check out', 'checkout', 'out', 'mark out', '2'].includes(text)) action = 'out';

    if (!action) {
      return res.json({
        reply: `👋 Welcome to Smart Attendance!\n\nSend:\n✅ *Check In* — to mark your arrival\n🚪 *Check Out* — to mark your departure\n\nNeed help? Contact HR.`
      });
    }

    const empResult = await pool.query(
      'SELECT * FROM employees WHERE phone = $1 AND active = TRUE',
      [normalizedPhone]
    );
    if (empResult.rows.length === 0) {
      return res.json({ reply: `❌ Your number (${phone}) is not registered.\n\nPlease contact HR to get registered.` });
    }

    const employee = empResult.rows[0];

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

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    await pool.query(
      'INSERT INTO checkin_tokens (token, phone, action, expires_at) VALUES ($1, $2, $3, $4)',
      [token, normalizedPhone, action, expiresAt]
    );

    const link = `${BASE_URL}/checkin?token=${token}`;
    const actionWord = action === 'in' ? 'Check In ✅' : 'Check Out 🚪';

    return res.json({
      reply: `Hi *${employee.name}*! 👋\n\n🔗 Click below to complete your *${actionWord}*:\n\n${link}\n\n⏳ Link expires in *5 minutes*.\n📍 Please allow location access when prompted.`,
      employee: employee.name,
      action
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Token Validate (called by check-in page) ──────────────────────────────────
app.get('/api/token/validate', checkinLimiter, async (req, res) => {
  const { token } = req.query;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    return res.status(400).json({ valid: false, error: 'Invalid token format' });
  }

  try {
    const result = await pool.query(
      `SELECT t.*, e.name, e.employee_id, e.department
       FROM checkin_tokens t JOIN employees e ON t.phone = e.phone
       WHERE t.token = $1`,
      [token]
    );

    if (result.rows.length === 0) return res.json({ valid: false, error: 'Invalid link' });
    const row = result.rows[0];
    if (row.used) return res.json({ valid: false, error: 'This link has already been used' });
    if (new Date() > new Date(row.expires_at)) return res.json({ valid: false, error: 'Link has expired. Please request a new one via WhatsApp.' });

    res.json({ valid: true, action: row.action, name: row.name, employee_id: row.employee_id, department: row.department });
  } catch (err) {
    console.error(err);
    res.status(500).json({ valid: false, error: 'Internal server error' });
  }
});

// ── Submit Attendance ─────────────────────────────────────────────────────────
app.post('/api/attendance/submit', checkinLimiter, async (req, res) => {
  const { token, latitude, longitude, deviceInfo, selfieUrl } = req.body;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    return res.status(400).json({ success: false, error: 'Invalid token' });
  }

  const lat = latitude != null ? parseFloat(latitude) : null;
  const lng = longitude != null ? parseFloat(longitude) : null;
  if (lat !== null && (isNaN(lat) || lat < -90  || lat > 90))  return res.status(400).json({ success: false, error: 'Invalid latitude' });
  if (lng !== null && (isNaN(lng) || lng < -180 || lng > 180)) return res.status(400).json({ success: false, error: 'Invalid longitude' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const tokenResult = await client.query(
      `SELECT t.*, e.name, e.employee_id
       FROM checkin_tokens t JOIN employees e ON t.phone = e.phone
       WHERE t.token = $1 FOR UPDATE`,
      [token]
    );

    if (tokenResult.rows.length === 0) throw new Error('Invalid token');
    const tok = tokenResult.rows[0];
    if (tok.used) throw new Error('Token already used');
    if (new Date() > new Date(tok.expires_at)) throw new Error('Token expired');

    let withinGeofence = null;
    let geofenceMessage = '';
    if (lat !== null && lng !== null) {
      const officeResult = await client.query('SELECT * FROM office_locations WHERE active = TRUE LIMIT 1');
      if (officeResult.rows.length > 0) {
        const office = officeResult.rows[0];
        const distance = haversine(lat, lng, parseFloat(office.latitude), parseFloat(office.longitude));
        withinGeofence = distance <= office.radius_meters;
        geofenceMessage = withinGeofence
          ? `📍 Location verified (${Math.round(distance)}m from office)`
          : `⚠️ Outside office zone (${Math.round(distance)}m away — allowed: ${office.radius_meters}m)`;
      }
    }

    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    const safeDeviceInfo = typeof deviceInfo === 'string' ? deviceInfo.slice(0, 500) : null;
    const safeSelfieUrl  = typeof selfieUrl  === 'string' ? selfieUrl.slice(0, 500_000) : null;

    await client.query(
      `INSERT INTO attendance (employee_id, phone, action, latitude, longitude, ip_address, device_info, selfie_url, within_geofence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [tok.employee_id, tok.phone, tok.action, lat, lng, ip, safeDeviceInfo, safeSelfieUrl, withinGeofence]
    );

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

// ── Admin API (all require active session) ────────────────────────────────────

app.get('/api/admin/attendance', adminLimiter, requireAdminSession, async (req, res) => {
  const { date, employee_id } = req.query;
  const params = [];
  let query = `
    SELECT a.*, e.name, e.department
    FROM attendance a JOIN employees e ON a.employee_id = e.employee_id
    WHERE 1=1
  `;

  if (date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date format' });
    params.push(date);
    query += ` AND DATE(a.timestamp) = $${params.length}`;
  }
  if (employee_id) {
    if (!/^[A-Za-z0-9_-]{1,50}$/.test(employee_id)) return res.status(400).json({ error: 'Invalid employee_id' });
    params.push(employee_id);
    query += ` AND a.employee_id = $${params.length}`;
  }
  query += ' ORDER BY a.timestamp DESC LIMIT 200';

  try {
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/admin/summary', adminLimiter, requireAdminSession, async (req, res) => {
  const { date } = req.query;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date format' });
  const targetDate = date || new Date().toISOString().split('T')[0];

  try {
    const result = await pool.query(`
      SELECT
        e.employee_id, e.name, e.department,
        MAX(CASE WHEN a.action = 'in'  THEN a.timestamp END) as check_in,
        MAX(CASE WHEN a.action = 'out' THEN a.timestamp END) as check_out,
        BOOL_OR(CASE WHEN a.within_geofence = FALSE THEN TRUE ELSE FALSE END) as flagged
      FROM employees e
      LEFT JOIN attendance a ON e.employee_id = a.employee_id AND DATE(a.timestamp) = $1
      WHERE e.active = TRUE
      GROUP BY e.employee_id, e.name, e.department
      ORDER BY e.name
    `, [targetDate]);

    const stats = {
      total:      result.rows.length,
      present:    result.rows.filter(r => r.check_in).length,
      absent:     result.rows.filter(r => !r.check_in).length,
      checkedOut: result.rows.filter(r => r.check_out).length,
      flagged:    result.rows.filter(r => r.flagged).length,
    };

    res.json({ date: targetDate, stats, employees: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/admin/employees', adminLimiter, requireAdminSession, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM employees ORDER BY name');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/employees', adminLimiter, requireAdminSession, async (req, res) => {
  const { phone, name, employee_id, department } = req.body;
  if (!phone || !name || !employee_id) return res.status(400).json({ error: 'phone, name, and employee_id are required' });
  const cleanPhone = phone.replace(/\D/g, '');
  if (cleanPhone.length < 7 || cleanPhone.length > 15) return res.status(400).json({ error: 'Invalid phone number' });

  try {
    const result = await pool.query(
      'INSERT INTO employees (phone, name, employee_id, department) VALUES ($1, $2, $3, $4) RETURNING *',
      [cleanPhone, name.slice(0, 100), employee_id.slice(0, 50), (department || '').slice(0, 100)]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/admin/office', adminLimiter, requireAdminSession, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM office_locations WHERE active = TRUE LIMIT 1');
    res.json(result.rows[0] || null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/admin/office', adminLimiter, requireAdminSession, async (req, res) => {
  const { latitude, longitude, radius_meters, name } = req.body;
  const lat    = parseFloat(latitude);
  const lng    = parseFloat(longitude);
  const radius = parseInt(radius_meters) || 200;
  if (isNaN(lat) || lat < -90  || lat > 90)   return res.status(400).json({ error: 'Invalid latitude' });
  if (isNaN(lng) || lng < -180 || lng > 180)  return res.status(400).json({ error: 'Invalid longitude' });
  if (radius < 50 || radius > 50000)          return res.status(400).json({ error: 'Radius must be 50–50000 meters' });

  try {
    await pool.query('UPDATE office_locations SET active = FALSE');
    const result = await pool.query(
      'INSERT INTO office_locations (name, latitude, longitude, radius_meters) VALUES ($1, $2, $3, $4) RETURNING *',
      [(name || 'Main Office').slice(0, 100), lat, lng, radius]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Utility ───────────────────────────────────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180, Δλ = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`🚀 Attendance Server running on port ${PORT}`);
  await new Promise(r => setTimeout(r, 3000));
  await initDB();
});
