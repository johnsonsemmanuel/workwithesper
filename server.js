require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const multer = require('multer');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const ESPERWORKS_API = 'https://api.tryesperworks.com/api';
const UPLOAD_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.doc', '.docx', '.jpg', '.jpeg', '.png', '.ppt', '.pptx', '.xls', '.xlsx', '.zip', '.txt'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowed.includes(ext)) return cb(new Error('File type not supported'), false);
    cb(null, true);
  },
});

// env validation
(() => {
  const key = process.env.ESPERWORKS_API_KEY;
  if (key && !key.startsWith('ew_live_') && !key.startsWith('ew_test_')) {
    console.warn('⚠ ESPERWORKS_API_KEY format looks invalid (should start with ew_live_ or ew_test_)');
  }
  ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'].forEach(k => {
    if (process.env[k] === '') delete process.env[k];
  });
})();

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : ['http://localhost:3000', 'https://espergloballtd.com', 'https://www.espergloballtd.com'];

// security
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false,
}));

app.use(compression());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(null, false);
  },
  methods: ['GET', 'POST'],
}));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Try again later.' },
});
app.use('/api/', limiter);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname)));

// structured logger
const logger = {
  info: (msg, meta) => console.log(JSON.stringify({ level: 'info', msg, ...meta, ts: new Date().toISOString() })),
  warn: (msg, meta) => console.warn(JSON.stringify({ level: 'warn', msg, ...meta, ts: new Date().toISOString() })),
  error: (msg, meta) => console.error(JSON.stringify({ level: 'error', msg, ...meta, ts: new Date().toISOString() })),
};

// rate API with retry + fallback
const ratesCache = { data: null, ts: 0 };
const RATES_API = 'https://open.er-api.com/v6/latest/USD';
const RATES_FALLBACK = 'https://api.exchangerate-api.com/v4/latest/USD';

AFRICAN_CURRENCIES = {
  USD: { code: 'USD', name: 'US Dollar', symbol: '$' },
  GHS: { code: 'GHS', name: 'Ghanaian Cedi', symbol: 'GH¢' },
  NGN: { code: 'NGN', name: 'Nigerian Naira', symbol: '₦' },
  KES: { code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh' },
  ZAR: { code: 'ZAR', name: 'South African Rand', symbol: 'R' },
  UGX: { code: 'UGX', name: 'Ugandan Shilling', symbol: 'USh' },
  TZS: { code: 'TZS', name: 'Tanzanian Shilling', symbol: 'TSh' },
  RWF: { code: 'RWF', name: 'Rwandan Franc', symbol: 'FRw' },
  XAF: { code: 'XAF', name: 'Central African CFA', symbol: 'FCFA' },
  XOF: { code: 'XOF', name: 'West African CFA', symbol: 'CFA' },
  EGP: { code: 'EGP', name: 'Egyptian Pound', symbol: 'E£' },
  MAD: { code: 'MAD', name: 'Moroccan Dirham', symbol: 'DH' },
  ZMW: { code: 'ZMW', name: 'Zambian Kwacha', symbol: 'ZK' },
  MZN: { code: 'MZN', name: 'Mozambican Metical', symbol: 'MT' },
  ETB: { code: 'ETB', name: 'Ethiopian Birr', symbol: 'Br' },
  BWP: { code: 'BWP', name: 'Botswana Pula', symbol: 'P' },
  GMD: { code: 'GMD', name: 'Gambian Dalasi', symbol: 'D' },
  LSL: { code: 'LSL', name: 'Lesotho Loti', symbol: 'L' },
  MUR: { code: 'MUR', name: 'Mauritian Rupee', symbol: 'Rs' },
  MWK: { code: 'MWK', name: 'Malawian Kwacha', symbol: 'MK' },
  SCR: { code: 'SCR', name: 'Seychellois Rupee', symbol: 'SR' },
  SLL: { code: 'SLL', name: 'Sierra Leonean Leone', symbol: 'Le' },
  SOS: { code: 'SOS', name: 'Somali Shilling', symbol: 'Sh' },
  TND: { code: 'TND', name: 'Tunisian Dinar', symbol: 'DT' },
};

async function fetchRatesWithRetry(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      const raw = await res.json();
      if (raw.result === 'success' || raw.base === 'USD') return raw.rates || {};
    } catch (e) {
      logger.warn('Rate API attempt failed', { url, attempt: i + 1, error: e.message });
      if (i === retries) throw e;
    }
  }
}

async function getRates() {
  if (ratesCache.data && Date.now() - ratesCache.ts < 3600000) return ratesCache.data;
  try {
    const rates = await fetchRatesWithRetry(RATES_API);
    const result = { USD: 1 };
    for (const code of Object.keys(AFRICAN_CURRENCIES)) {
      if (code !== 'USD' && rates[code]) result[code] = rates[code];
    }
    ratesCache.data = { rates: result, currencies: AFRICAN_CURRENCIES, base: 'USD' };
    ratesCache.ts = Date.now();
    return ratesCache.data;
  } catch (e) {
    logger.warn('Primary rate API failed, trying fallback', { error: e.message });
    try {
      const rates = await fetchRatesWithRetry(RATES_FALLBACK);
      const result = { USD: 1 };
      for (const code of Object.keys(AFRICAN_CURRENCIES)) {
        if (code !== 'USD' && rates[code]) result[code] = rates[code];
      }
      ratesCache.data = { rates: result, currencies: AFRICAN_CURRENCIES, base: 'USD' };
      ratesCache.ts = Date.now();
      return ratesCache.data;
    } catch (e2) {
      logger.error('All rate APIs failed', { error: e2.message });
      if (ratesCache.data) return ratesCache.data;
      throw e2;
    }
  }
}

function sanitize(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/[<>"'&]/g, '').trim();
}

function convertPrice(usd, currency, rates) {
  const r = rates[currency] || 1;
  const v = usd * r;
  return v >= 1 ? Math.round(v) : Math.round(v * 100) / 100;
}

function buildQuoteEmail(data) {
  const { fullName, email, phone, company, service, category, complexity, description, price, estimatedDays, currency: cur } = data;
  const curInfo = AFRICAN_CURRENCIES[cur] || AFRICAN_CURRENCIES.USD;
  const symbol = curInfo.symbol;
  const converted = convertPrice(Number(price), cur, ratesCache.data?.rates || {});
  const formattedPrice = converted >= 1000 ? converted.toLocaleString() : String(converted);

  return {
    subject: `New Quote Request: ${service} — Esper Partners`,
    clientHtml: `
      <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 30px; background: #f8fafc;">
        <div style="background: linear-gradient(135deg, #1e3a5f 0%, #2d5a87 100%); padding: 30px; border-radius: 12px; text-align: center;">
          <img src="https://espergloballtd.com/logo.png" alt="Esper Partners" style="height: 40px; margin-bottom: 16px;" />
          <h1 style="color: #fff; margin: 0; font-size: 22px;">Quote Request Received</h1>
          <p style="color: rgba(255,255,255,0.85); margin: 8px 0 0; font-size: 14px;">We'll review and respond within 48 hours</p>
        </div>

        <div style="background: #fff; border-radius: 12px; padding: 28px; margin-top: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.08);">
          <h2 style="color: #1e293b; font-size: 16px; margin: 0 0 20px; border-bottom: 2px solid #e2e8f0; padding-bottom: 12px;">Summary</h2>
          <table style="width:100%; border-collapse:collapse; font-size:13px;">
            ${[
              ['Name', fullName], ['Email', email], ['Phone', phone], ['Company', company],
              ['Category', category], ['Service', service], ['Package', complexity],
              ['Description', description],
            ].filter(r => r[1]).map(([l, v]) =>
              `<tr><td style="padding:10px 0;border-bottom:1px solid #f1f5f9;color:#64748b;">${l}</td><td style="padding:10px 0;border-bottom:1px solid #f1f5f9;color:#1e293b;font-weight:500;text-align:right;">${v}</td></tr>`
            ).join('')}
            <tr>
              <td style="padding:14px 0 4px;color:#64748b;font-size:13px;">Estimated Price</td>
              <td style="padding:14px 0 4px;color:#059669;font-weight:700;text-align:right;font-size:24px;">${symbol} ${formattedPrice}</td>
            </tr>
            <tr>
              <td style="padding:4px 0 0;color:#64748b;font-size:12px;">USD Equivalent</td>
              <td style="padding:4px 0 0;color:#64748b;font-weight:400;text-align:right;font-size:14px;">$${Number(price).toLocaleString()}</td>
            </tr>
            <tr>
              <td style="padding:4px 0 0;color:#64748b;font-size:13px;">Estimated Delivery</td>
              <td style="padding:4px 0 0;color:#1e293b;font-weight:500;text-align:right;">${estimatedDays} business days</td>
            </tr>
          </table>
        </div>

        <div style="text-align:center;margin-top:24px;padding:20px;background:#eff6ff;border-radius:12px;">
          <p style="color:#1e3a5f;font-weight:600;margin:0;">What happens next?</p>
          <p style="color:#475569;font-size:13px;margin:8px 0 0;line-height:1.6;">
            Our team will review your request and send a formal proposal within 48 hours.<br />
            Need it sooner? <a href="https://wa.me/233208713610" style="color:#1e3a5f;font-weight:600;">Chat with us on WhatsApp</a>
          </p>
        </div>

        <div style="text-align:center;margin-top:20px;padding:16px;border-top:1px solid #e2e8f0;">
          <p style="color:#94a3b8;font-size:11px;margin:0;">
            Esper Partners &bull; www.espergloballtd.com &bull; +233 20 871 3610<br />
            This is an automated confirmation from our service request system.
          </p>
        </div>
      </div>
    `,
  };
}

async function sendViaNodemailer(data) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return false;
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  const mail = buildQuoteEmail(data);
  await transporter.sendMail({
    from: `"Esper Partners" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
    to: data.email,
    cc: process.env.NOTIFICATION_EMAIL || process.env.SMTP_USER,
    subject: mail.subject,
    html: mail.clientHtml,
  });
  return true;
}

async function findClientByEmail(email) {
  const res = await fetch(`${ESPERWORKS_API}/clients?email=${encodeURIComponent(email)}`, {
    headers: {
      'Authorization': `Bearer ${process.env.ESPERWORKS_API_KEY}`,
      'X-API-Key': process.env.ESPERWORKS_API_KEY,
    },
  });
  if (!res.ok) return null;
  const body = await res.json();
  const clients = body.data || [];
  return clients.find(c => c.email.toLowerCase() === email.toLowerCase()) || null;
}

async function createClient(data) {
  const existing = await findClientByEmail(data.email);
  if (existing) {
    logger.info('Found existing client', { client_id: existing.id, email: data.email });
    return existing;
  }

  const res = await fetch(`${ESPERWORKS_API}/clients`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.ESPERWORKS_API_KEY}`,
      'X-API-Key': process.env.ESPERWORKS_API_KEY,
    },
    body: JSON.stringify({
      name: data.fullName,
      email: data.email,
      phone: data.phone || undefined,
      company: data.company || undefined,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Client creation error ${res.status}: ${errBody}`);
  }

  const result = await res.json();
  const client = result.client || result;
  logger.info('Created client', { client_id: client.id, email: data.email });
  return client;
}

async function createEsperWorksInvoice(data) {
  if (!process.env.ESPERWORKS_API_KEY) return null;

  const client = await createClient(data);

  const today = new Date();
  const dueDate = new Date(today.getTime() + 3 * 24 * 60 * 60 * 1000);

  const payload = {
    client_id: client.id,
    issue_date: today.toISOString().split('T')[0],
    due_date: dueDate.toISOString().split('T')[0],
    items: [{
      description: `${data.service} — ${data.complexity} Package`,
      quantity: 1,
      rate: data.price,
    }],
    currency: data.currency || 'USD',
    notes: `Category: ${data.category} | Est. Days: ${data.estimatedDays} | ${(data.description || '').slice(0, 500)}`,
    status: 'draft',
  };

  const res = await fetch(`${ESPERWORKS_API}/invoices`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.ESPERWORKS_API_KEY}`,
      'X-API-Key': process.env.ESPERWORKS_API_KEY,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Invoice creation error ${res.status}: ${errBody}`);
  }

  const result = await res.json();
  const inv = result.invoice || result;
  logger.info('Invoice created', { invoice_id: inv.id, number: inv.invoice_number, client_id: client.id });
  return result;
}

// routes
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    services: {
      esperworks: !!process.env.ESPERWORKS_API_KEY,
      email: !!process.env.SMTP_USER,
    },
    rates_configured: AFRICAN_CURRENCIES ? Object.keys(AFRICAN_CURRENCIES).length : 0,
  });
});

app.get('/api/rates', async (req, res) => {
  try {
    const data = await getRates();
    res.json(data);
  } catch (e) {
    if (ratesCache.data) return res.json(ratesCache.data);
    res.status(502).json({ error: 'Failed to fetch rates' });
  }
});

app.post('/api/send-quote', upload.single('attachment'), async (req, res) => {
  try {
    const data = req.body;
    const attachment = req.file;

    const hasEmail = !!(process.env.SMTP_USER && process.env.SMTP_PASS);
    const hasEsper = !!process.env.ESPERWORKS_API_KEY;
    const errors = [];

    if (!hasEmail && !hasEsper) {
      return res.json({
        success: true,
        message: 'Quote received! Configure SMTP or ESPERWORKS_API_KEY in .env to enable delivery.',
      });
    }

    const sanitized = {
      fullName: sanitize(data.fullName),
      email: sanitize(data.email),
      phone: sanitize(data.phone || ''),
      company: sanitize(data.company || ''),
      service: sanitize(data.service || ''),
      category: sanitize(data.category || ''),
      complexity: sanitize(data.complexity || ''),
      description: sanitize(data.description || ''),
      price: Number(data.price) || 0,
      estimatedDays: Number(data.estimatedDays) || 1,
      currency: sanitize(data.currency) || 'USD',
    };

    if (!sanitized.fullName || !sanitized.email || !sanitized.description) {
      return res.status(400).json({ success: false, message: 'Name, email, and description required.' });
    }

    if (hasEsper) {
      try {
        const invoice = await createEsperWorksInvoice(sanitized);
        const inv = invoice?.invoice || invoice;
        sanitized.invoiceUrl = inv?.payment_url || null;
        sanitized.invoiceNumber = inv?.invoice_number || inv?.id || null;
      } catch (e) {
        errors.push('Invoice: ' + e.message);
        logger.error('Invoice creation failed', { error: e.message, email: sanitized.email });
      }
    }

    if (hasEmail) {
      try {
        await sendViaNodemailer(sanitized);
        logger.info('Email sent', { email: sanitized.email });
      } catch (e) {
        errors.push('Email: ' + e.message);
        logger.error('Email send failed', { error: e.message, email: sanitized.email });
      }
    }

    if (errors.length) {
      return res.status(500).json({ success: false, message: errors.join(' | ') });
    }

    const parts = [];
    if (hasEsper) parts.push('invoice created in EsperWorks');
    if (hasEmail) parts.push('confirmation emailed');

    res.json({
      success: true,
      message: `Quote submitted successfully! ${parts.length ? parts.join(' & ') + '.' : ''} We'll respond within 48 hours.`,
      ...(sanitized.invoiceUrl ? { paymentUrl: sanitized.invoiceUrl } : {}),
    });
  } catch (error) {
    logger.error('Server error', { error: error.message });
    if (req.file && req.file.path) {
      fs.unlink(req.file.path, () => {});
    }
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  logger.info('Server started', { port: PORT, node: process.version });
  const hasEsper = !!process.env.ESPERWORKS_API_KEY;
  const hasEmail = !!(process.env.SMTP_USER && process.env.SMTP_PASS);
  if (!hasEsper && !hasEmail) {
    logger.warn('No API keys configured — running in preview mode');
  } else {
    logger.info('Services', { esperworks: hasEsper, email: hasEmail });
  }
});
