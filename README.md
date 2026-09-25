# ⚡ Smart Attendance System

A complete, production-ready WhatsApp-triggered attendance system with GPS verification, geofencing, admin dashboard, and n8n automation.

---

## 🚀 Quick Start (3 Steps)

### Step 1 — Clone & Configure
```bash
cp .env.example .env
# Edit .env with your BASE_URL and WhatsApp credentials (see below)
```

### Step 2 — Start Everything
```bash
docker compose up -d
```

### Step 3 — Open the Apps
| Service | URL | Credentials |
|---|---|---|
| 🖥️ Admin Dashboard | http://localhost:4000/admin | `Admin@1234` |
| ✅ Check-in Page | http://localhost:4000/checkin?token=TEST | — |
| ⚙️ n8n Automation | http://localhost:5678 | admin / see `.env` `N8N_BASIC_AUTH_PASSWORD` |

> **Test immediately** → Go to Admin (password: `Admin@1234`) → Test Simulator tab → enter a registered phone → click Send

---

## 📁 Project Structure

```
attendance-system/
├── docker-compose.yml          # All services in one command
├── .env.example                # Copy to .env and configure
├── .env                        # Your local secrets (never commit)
│
├── backend/
│   ├── server.js               # Express API (all endpoints)
│   ├── package.json
│   └── Dockerfile
│
├── frontend/
│   ├── checkin/index.html      # Employee check-in page (GPS + selfie)
│   └── admin/
│       ├── index.html          # Admin dashboard
│       └── admin.js            # All admin JS (CSP-compliant, no inline scripts)
│
└── n8n/
    └── attendance-workflow.json  # Import this into n8n
```

---

## ⚙️ How It Works

```
Employee sends "Check In" on WhatsApp
         ↓
WhatsApp Cloud API → n8n Webhook
         ↓
n8n calls our backend API
         ↓
Backend verifies employee + generates secure token link
         ↓
n8n sends link back to employee via WhatsApp
         ↓
Employee opens link → grants GPS permission
         ↓
Backend validates: geofence + duplicate check + device info
         ↓
Attendance saved to PostgreSQL
         ↓
Admin sees real-time data in dashboard
```

---

## 🔧 Environment Variables

Copy `.env.example` to `.env` and fill in your values:

```env
# Public URL of your server (used in WhatsApp links)
# Local:      http://localhost:4000
# Production: https://your-domain.com
BASE_URL=http://localhost:4000

# Admin dashboard password
ADMIN_PASSWORD=Admin@1234

# Set to true when serving over HTTPS
COOKIE_SECURE=false

# WhatsApp Cloud API (from Meta Developer Portal)
WHATSAPP_TOKEN=your_system_user_token
WHATSAPP_PHONE_ID=your_phone_number_id
WHATSAPP_VERIFY_TOKEN=your_verify_token
```

> **Production deployment:** Set `BASE_URL` to your real domain, `COOKIE_SECURE=true`, and update `ADMIN_PASSWORD` to something strong.

---

## 📱 WhatsApp Cloud API Setup

1. Go to [developers.facebook.com](https://developers.facebook.com)
2. Create an App → Add **WhatsApp** product
3. Get your **Phone Number ID** and **System User Token**
4. Set Webhook URL to: `http://YOUR_SERVER:5678/webhook/whatsapp-incoming`
5. Set Webhook Verify Token to: `attendance_verify_2024`
6. Subscribe to: `messages`

---

## ⚙️ n8n Workflow Setup

1. Open n8n at http://localhost:5678 (admin / n8npassword123)
2. Go to **Workflows** → **Import from File**
3. Import `n8n/attendance-workflow.json`
4. Set environment variables in n8n Settings:
   - `WHATSAPP_TOKEN` — your Meta token
   - `WHATSAPP_PHONE_ID` — your phone number ID
   - `ATTENDANCE_BACKEND_URL` — `http://backend:4000`
5. **Activate** the workflow

---

## 📊 API Reference

### WhatsApp Webhook (called by n8n)
```
POST /api/whatsapp/webhook
Body: { phone: "919876543210", message: "check in" }
Response: { reply: "...", employee: "Name", action: "in" }
```

### Validate Token (called by check-in page)
```
GET /api/token/validate?token=<token>
Response: { valid: true, action: "in", name: "Rahul", employee_id: "EMP001" }
```

### Submit Attendance (called by check-in page)
```
POST /api/attendance/submit
Body: { token, latitude, longitude, deviceInfo, selfieUrl }
Response: { success: true, action, name, timestamp, withinGeofence }
```

### Admin APIs
```
GET  /api/admin/summary?date=2024-01-15   → Daily summary with stats
GET  /api/admin/attendance?date=2024-01-15 → Raw attendance logs
GET  /api/admin/employees                  → All employees
POST /api/admin/employees                  → Add employee
GET  /api/admin/office                     → Office geofence settings
PUT  /api/admin/office                     → Update geofence
```

---

## 👥 Adding Employees

**Via Admin Dashboard:**
1. Go to Admin → Employees tab
2. Fill in Name, Employee ID, WhatsApp Number (with country code), Department
3. Click Add Employee

**Phone Number Format:**
- India: `919876543210` (91 = country code, no + or spaces)
- US: `15551234567`

**Sample employees pre-loaded:**
- `919876543210` → Rahul Sharma (EMP001)
- `919876543211` → Priya Patel (EMP002)
- `919876543212` → Amit Verma (EMP003)

---

## 📍 Geofence Setup

1. Go to Admin → Office Settings
2. Either enter coordinates manually or click **"Use My Location"**
3. Set radius (default: 200 meters)
4. Save

Employees checking in from outside the radius are **flagged** in the dashboard (attendance still recorded, just flagged).

---

## 🧪 Testing Without WhatsApp

Use the built-in **Test Simulator**:
1. Admin → Test Simulator tab
2. Enter a registered phone number
3. Select Check In / Check Out
4. Click Send → get the check-in link
5. Open the link to test GPS capture

---

## 🔐 Security Features

| Feature | Details |
|---|---|
| Token expiry | Links expire in **5 minutes** |
| Single use | Each token can only be used **once** |
| Duplicate prevention | Can't check in twice on the same day |
| Geofencing | Flags employees outside the allowed radius |
| IP logging | Every request logs the IP address |
| Device info | Browser/device fingerprint stored |

---

## 🚀 Production Deployment

### With a Domain + HTTPS:

1. Point your domain DNS to your server
2. Install nginx + certbot for SSL
3. Update `.env`:
   ```env
   BASE_URL=https://your-domain.com
   N8N_HOST=your-domain.com
   N8N_WEBHOOK_URL=https://your-domain.com:5678
   ```
4. `docker compose up -d`

### Nginx config snippet:
```nginx
server {
    server_name your-domain.com;
    location / { proxy_pass http://localhost:4000; }
}
server {
    server_name n8n.your-domain.com;
    location / { proxy_pass http://localhost:5678; }
}
```

---

## 🛠️ Useful Commands

```bash
# Start all services
docker compose up -d

# View logs
docker compose logs -f backend
docker compose logs -f n8n

# Stop everything
docker compose down

# Reset database (WARNING: deletes all data)
docker compose down -v && docker compose up -d

# Restart a single service
docker compose restart backend
```

---

## 🔮 Future Enhancements (Ready to Add)

- [ ] Face recognition via OpenCV/AWS Rekognition
- [ ] Shift scheduling (morning/evening shifts)
- [ ] Payroll integration export
- [ ] SMS fallback (Twilio)
- [ ] Mobile PWA app
- [ ] GPS spoof detection
- [ ] Slack/Teams notifications for managers

---

## 📝 License

MIT — Use freely for personal and commercial projects.
"# Attendance-system-using-n8n" 
