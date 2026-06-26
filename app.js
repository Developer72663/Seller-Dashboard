require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const flash = require('connect-flash');
const cookieParser = require('cookie-parser');
const path = require('path');
const methodOverride = require('method-override');
const rateLimit = require('express-rate-limit');
const passport = require('passport');
const multer = require('multer');
const fs = require('fs');

// Try to load node-cron, fallback gracefully if not installed
let cron = null;
try {
  cron = require('node-cron');
  console.log('✅ node-cron loaded');
} catch (err) {
  console.warn('⚠️ node-cron not installed. Daily funds release job will not run automatically.');
  console.warn('   Run: npm install node-cron');
}

// Try to load release funds job
let releaseFundsJob = null;
try {
  const releaseModule = require('./jobs/releaseFunds');
  releaseFundsJob = releaseModule.releaseFundsJob;
  console.log('✅ Release funds job loaded');
} catch (err) {
  console.warn('⚠️ Release funds job not available:', err.message);
}

const app = express();
const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════════════
// RATE LIMITING
// ═══════════════════════════════════════════════════
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again later.'
});
app.use('/api/', limiter);

// ═══════════════════════════════════════════════════
// SUPPRESS MONGOOSE WARNINGS
// ═══════════════════════════════════════════════════
process.on('warning', (warning) => {
  if (warning.code === 'MONGOOSE' && warning.message.includes('Duplicate schema index')) {
    return;
  }
  console.warn(warning);
});

// ═══════════════════════════════════════════════════
// DATABASE CONNECTION
// ═══════════════════════════════════════════════════
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/shopp123')
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => {
    console.error('❌ MongoDB Error:', err);
    process.exit(1);
  });

// ═══════════════════════════════════════════════════
// VIEW ENGINE
// ═══════════════════════════════════════════════════
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ═══════════════════════════════════════════════════
// STATIC FILES
// ═══════════════════════════════════════════════════
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ═══════════════════════════════════════════════════
// BODY PARSING
// ═══════════════════════════════════════════════════
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(methodOverride('_method'));

// ═══════════════════════════════════════════════════
// SESSION (for flash messages)
// ═══════════════════════════════════════════════════
app.use(session({
  secret: process.env.SESSION_SECRET || 'shopp123-super-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 7,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production'
  }
}));

// ═══════════════════════════════════════════════════
// PASSPORT
// ═══════════════════════════════════════════════════
app.use(passport.initialize());

// ═══════════════════════════════════════════════════
// FLASH MESSAGES
// ═══════════════════════════════════════════════════
app.use(flash());

// ═══════════════════════════════════════════════════
// JWT AUTH MIDDLEWARE (sets req.seller from cookie)
// ═══════════════════════════════════════════════════
app.use((req, res, next) => {
  const { verifyToken } = require('./services/authentication');
  const token = req.cookies['token'];

  if (!token) {
    req.seller = null;
    return next();
  }

  try {
    const decoded = verifyToken(token);
    req.seller = decoded || null;
  } catch (error) {
    req.seller = null;
  }
  next();
});

// ═══════════════════════════════════════════════════
// GLOBAL VARIABLES & LOCALS
// ═══════════════════════════════════════════════════
app.use((req, res, next) => {
  res.locals.success_msg = req.flash('success');
  res.locals.error_msg = req.flash('error');
  res.locals.messages = {
    success: req.flash('success'),
    error: req.flash('error')
  };
  res.locals.user = req.user || req.session.user || null;
  res.locals.seller = req.seller || null;
  res.locals.admin = req.session.admin || null;
  res.locals.currentPath = req.path;
  next();
});

// ═══════════════════════════════════════════════════
// GLOBAL EJS HELPERS
// ═══════════════════════════════════════════════════
app.locals.truncate = function(text, length = 60) {
  if (!text) return '';
  text = String(text);
  if (text.length <= length) return text;
  return text.substring(0, length).trim() + '...';
};

app.locals.formatDate = function(date) {
  if (!date) return '';
  return new Date(date).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric'
  });
};

app.locals.formatCurrency = function(amount) {
  if (amount === undefined || amount === null) return '₹0';
  return '₹' + Number(amount).toLocaleString('en-IN');
};

// ═══════════════════════════════════════════════════
// MULTER CONFIGURATION
// ═══════════════════════════════════════════════════
const uploadDirs = [
  'uploads/products/thumbnails',
  'uploads/products/images',
  'uploads/products/videos',
  'uploads/products/sizecharts',
  'uploads/sellers/logos',
  'uploads/sellers/documents'
];

uploadDirs.forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dirMap = {
      thumbnail: 'uploads/products/thumbnails/',
      images: 'uploads/products/images/',
      video: 'uploads/products/videos/',
      sizeChartImage: 'uploads/products/sizecharts/',
      businessLogo: 'uploads/sellers/logos/',
      document: 'uploads/sellers/documents/'
    };
    cb(null, dirMap[file.fieldname] || 'uploads/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const fileFilter = (req, file, cb) => {
  const allowedImages = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'];
  const allowedVideos = ['video/mp4', 'video/webm', 'video/ogg'];

  if (['thumbnail', 'images', 'sizeChartImage', 'businessLogo'].includes(file.fieldname)) {
    cb(null, allowedImages.includes(file.mimetype));
  } else if (file.fieldname === 'video') {
    cb(null, allowedVideos.includes(file.mimetype));
  } else {
    cb(null, true);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 50 * 1024 * 1024 }
});

app.locals.upload = upload;

// ═══════════════════════════════════════════════════
// ROUTE LOADING (with fallbacks for missing files)
// ═══════════════════════════════════════════════════

function safeRequire(routePath, mountPath) {
  try {
    const route = require(routePath);
    app.use(mountPath, route);
    console.log(`✅ Route loaded: ${mountPath}`);
  } catch (err) {
    console.warn(`⚠️ Route skipped (not found): ${routePath} — ${err.message}`);
  }
}

// ─── Seller Google Auth (MUST come before regular seller routes) ───
safeRequire('./routes/SellerGoogleAuth', '/seller');

// ─── Seller Routes (signin, signup, dashboard, orders, etc.) ───
safeRequire('./routes/Seller', '/seller');

// ─── Earnings Routes ───
safeRequire('./routes/earnings', '/seller/earnings');

// ─── Settings Routes ───
safeRequire('./routes/settings', '/seller/settings');

// ─── Admin Routes ───
safeRequire('./routes/Admin', '/admin');

// ─── Product Routes ───
safeRequire('./routes/product', '/products');

// ─── Customer Order Routes (NEW) ───
safeRequire('./routes/customerOrder', '/orders');

// ─── Optional routes (uncomment when ready) ───
// safeRequire('./routes/index', '/');
// safeRequire('./routes/auth', '/auth');
// safeRequire('./routes/cart', '/cart');

// ═══════════════════════════════════════════════════
// HOME / LANDING PAGE
// ═══════════════════════════════════════════════════
app.get('/', (req, res) => {
  res.render('home', {
    title: 'SellerHub',
    seller: req.seller || null
  });
});

// ═══════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// ═══════════════════════════════════════════════════
// ERROR HANDLING
// ═══════════════════════════════════════════════════
app.use((err, req, res, next) => {
  console.error('🚨 Error:', err);

  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      req.flash('error', 'File size too large. Max 50MB allowed.');
    } else {
      req.flash('error', 'File upload error: ' + err.message);
    }
    return res.redirect('back');
  }

  const statusCode = err.status || 500;
  const errorMessage = process.env.NODE_ENV === 'production'
    ? 'Something went wrong!'
    : (err.message || 'An unexpected error occurred');

  res.status(statusCode).render('error', {
    title: 'Error',
    message: errorMessage
  });
});

// ═══════════════════════════════════════════════════
// 404 HANDLER
// ═══════════════════════════════════════════════════
app.use((req, res) => {
  res.status(404).render('404', {
    title: 'Page Not Found',
    message: 'The page you are looking for does not exist.'
  });
});

// ═══════════════════════════════════════════════════
// CRON JOB: RELEASE FUNDS AFTER RETURN POLICY ENDS
// Runs every day at midnight (00:00)
// ═══════════════════════════════════════════════════
if (cron && releaseFundsJob) {
  cron.schedule('0 0 * * *', () => {
    console.log('⏰ Running daily funds release job...');
    releaseFundsJob().catch(err => {
      console.error('❌ Funds release job failed:', err.message);
    });
  });
  console.log('✅ Daily funds release cron scheduled (midnight)');
} else {
  console.log('⚠️ Funds release cron NOT scheduled. Install node-cron to enable.');
}

// ═══════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📦 Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
