const express = require('express');
const router = express.Router();
const Seller = require('../models/Seller');
const Order = require('../models/Order');
const Wallet = require('../models/Wallet');
const { sendOTPEmail, sendResetPasswordEmail } = require('../services/email');
const { creatTokenForUser } = require('../services/authentication');
const crypto = require('crypto');
const { loginLimiter, otpLimiter } = require('../middlewares/rateLimiting');
const { validateEmail } = require('../middlewares/validation');

const otpStore = new Map();
const resetTokens = new Map();

// ====================== AUTH HELPER ======================
const checkSellerAuth = async (req, res, next) => {
  if (!req.seller) {
    return res.redirect('/seller/signin');
  }
  next();
};

// ====================== GET SELLER SIGNIN PAGE ======================
router.get('/signin', (req, res) => {
  if (req.seller && (req.seller.role === 'SELLER' || req.seller.role === 'ADMIN')) {
    return res.redirect('/seller/dashboard');
  }
  res.render('sellerSignin', { error: null });
});

// ====================== POST SELLER SIGNIN ======================
router.post('/signin', loginLimiter, async (req, res) => {
  const { email, password } = req.body;

  try {
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required"
      });
    }

    if (!validateEmail(email)) {
      return res.status(400).json({
        success: false,
        message: "Invalid email format"
      });
    }

    const token = await Seller.matchPassword(email, password);
    const seller = await Seller.findOne({ email: email.toLowerCase() });

    if (!seller.isGoogleUser && seller.verificationStatus === 'Pending') {
      return res.status(403).json({
        success: false,
        message: "Your account is under review. Please wait for admin approval.",
        redirect: "/seller/pending"
      });
    }
    if (!seller.isGoogleUser && seller.verificationStatus === 'Rejected') {
      return res.status(403).json({
        success: false,
        message: "Your account has been rejected. Contact support for more info.",
        rejectionReason: seller.rejectionReason
      });
    }

    res.cookie("token", token, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: "/"
    });

    res.status(200).json({
      success: true,
      message: "Login successful",
      redirect: "/seller/dashboard"
    });

  } catch (error) {
    console.error("❌ Seller Signin Error:", error.message);
    res.status(401).json({
      success: false,
      message: error.message || "Invalid email or password"
    });
  }
});

// ====================== GET SELLER SIGNUP PAGE ======================
router.get('/signup', (req, res) => {
  if (req.seller && (req.seller.role === 'SELLER' || req.seller.role === 'ADMIN')) {
    return res.redirect('/seller/dashboard');
  }
  res.render('sellerSignup', { error: null });
});

// ====================== SEND OTP ======================
router.post('/send-otp', otpLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email || !validateEmail(email)) {
    return res.status(400).json({ success: false, message: 'Valid email is required' });
  }

  try {
    const normalizedEmail = email.toLowerCase().trim();
    const existingSeller = await Seller.findOne({ email: normalizedEmail });
    if (existingSeller) {
      return res.status(409).json({ success: false, message: "Email already registered. Please login instead." });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = Date.now() + 5 * 60 * 1000;
    otpStore.set(normalizedEmail, { otp, expires });

    try {
      await sendOTPEmail(normalizedEmail, otp);
    } catch (emailError) {
      return res.status(500).json({ success: false, message: `Email service error: ${emailError.message}` });
    }

    res.json({ success: true, message: 'OTP sent successfully. Expires in 5 minutes.' });

  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Failed to send OTP.' });
  }
});

// ====================== POST SELLER SIGNUP ======================
router.post('/signup', async (req, res) => {
  const {
    fullName, email, password, otp,
    businessName, businessAddress, phoneNumber,
    gstNumber, panNumber, bankAccountNumber, ifscCode
  } = req.body;

  if (!fullName || !email || !password || !otp) {
    return res.status(400).json({ success: false, message: "All required fields are missing" });
  }

  try {
    const normalizedEmail = email.toLowerCase().trim();

    if (!validateEmail(normalizedEmail)) {
      return res.status(400).json({ success: false, message: "Invalid email format" });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: "Password must be at least 6 characters" });
    }

    const stored = otpStore.get(normalizedEmail);
    if (!stored) {
      return res.status(400).json({ success: false, message: "No OTP found. Request a new one." });
    }
    if (stored.otp !== otp) {
      return res.status(400).json({ success: false, message: "Invalid OTP" });
    }
    if (stored.expires < Date.now()) {
      otpStore.delete(normalizedEmail);
      return res.status(400).json({ success: false, message: "OTP expired. Request a new one." });
    }

    const existingSeller = await Seller.findOne({ email: normalizedEmail });
    if (existingSeller) {
      return res.status(409).json({ success: false, message: "Email already registered." });
    }

    const newSeller = await Seller.create({
      fullName: fullName.trim(),
      email: normalizedEmail,
      password,
      businessName: businessName || '',
      businessAddress: businessAddress || '',
      phoneNumber: phoneNumber || '',
      gstNumber: gstNumber || '',
      panNumber: panNumber || '',
      bankAccountNumber: bankAccountNumber || '',
      ifscCode: ifscCode || '',
      verificationStatus: 'Pending',
      isGoogleUser: false
    });

    // Create wallet for new seller
    await Wallet.create({ seller: newSeller._id });

    otpStore.delete(normalizedEmail);

    res.json({
      success: true,
      message: "Account created! Your application is under review.",
      redirect: "/seller/pending"
    });

  } catch (error) {
    console.error("❌ Signup Error:", error.message);
    res.status(500).json({ success: false, message: error.message || "Signup failed." });
  }
});

// ====================== GET PENDING REVIEW PAGE ======================
router.get('/pending', (req, res) => {
  res.render('sellerPending', {
    title: 'Account Under Review - SellerHub',
    seller: req.seller || null
  });
});

// ====================== GET SELLER DASHBOARD ======================
router.get('/dashboard', async (req, res) => {
  if (!req.seller) {
    return res.redirect('/seller/signin');
  }

  try {
    const seller = await Seller.findById(req.seller._id).lean();
    if (!seller) {
      res.clearCookie("token");
      return res.redirect('/seller/signin');
    }

    if (!seller.isGoogleUser && seller.verificationStatus === 'Pending') {
      return res.redirect('/seller/pending');
    }
    if (!seller.isGoogleUser && seller.verificationStatus === 'Rejected') {
      return res.redirect('/seller/pending');
    }

    // Fetch product stats
    let Product;
    try { Product = require('../models/Product'); } catch (e) { Product = null; }

    let stats = {
      totalProducts: 0,
      activeProducts: 0,
      lowStockProducts: 0,
      outOfStockProducts: 0,
      totalRevenue: 0
    };
    let recentProducts = [];
    let topSelling = [];

    if (Product) {
      const sellerId = seller._id.toString();
      const allProducts = await Product.find({ seller: sellerId }).lean();

      stats.totalProducts = allProducts.length;
      stats.activeProducts = allProducts.filter(p => p.status === 'active' || p.isActive === true).length;
      stats.outOfStockProducts = allProducts.filter(p => p.stock === 0 || p.quantity === 0).length;
      stats.lowStockProducts = allProducts.filter(p => {
        const stock = p.stock ?? p.quantity ?? 0;
        return stock > 0 && stock <= 5;
      }).length;
      stats.totalRevenue = allProducts.reduce((sum, p) => sum + (p.revenue || 0), 0);

      recentProducts = allProducts
        .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
        .slice(0, 5);

      topSelling = allProducts
        .filter(p => (p.revenue || 0) > 0)
        .sort((a, b) => (b.revenue || 0) - (a.revenue || 0))
        .slice(0, 5);
    }

    // Fetch wallet stats
    const wallet = await Wallet.getOrCreate(seller._id);

    // Fetch new orders count
    const newOrdersCount = await Order.countDocuments({
      seller: seller._id,
      status: { $in: ['pending', 'confirmed'] }
    });

    res.render('sellerDashboard', {
      title: seller.role === 'ADMIN' ? 'Admin Dashboard - SellerHub' : 'Seller Dashboard - SellerHub',
      seller: seller,
      stats: stats,
      recentProducts: recentProducts,
      topSelling: topSelling,
      wallet: {
        availableBalance: wallet.availableBalance,
        pendingBalance: wallet.pendingBalance,
        totalEarned: wallet.totalEarned
      },
      newOrdersCount: newOrdersCount,
      salesData: [],
      categoryData: []
    });
  } catch (error) {
    console.error("❌ Dashboard Error:", error.message);
    res.status(500).send("Internal Server Error");
  }
});

// ====================== GET SELLER ORDERS (PRIVACY-FOCUSED) ======================
router.get('/orders', async (req, res) => {
  if (!req.seller) {
    return res.redirect('/seller/signin');
  }

  try {
    const sellerId = req.seller._id;
    const page = parseInt(req.query.page) || 1;
    const limit = 20;
    const skip = (page - 1) * limit;
    const status = req.query.status || '';
    const search = req.query.search || '';

    // Build query
    let query = { seller: sellerId };
    if (status) query.status = status;
    if (search) {
      query.$or = [
        { orderNumber: { $regex: search, $options: 'i' } }
      ];
    }

    // Get orders - ONLY select fields safe for seller (NO customer PII)
    const [orders, totalOrders, statAgg] = await Promise.all([
      Order.find(query)
        .select('-customer -customerName -customerEmail -customerPhone -shippingAddress -paymentDetails')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Order.countDocuments(query),
      Order.aggregate([
        { $match: { seller: sellerId } },
        { $group: {
          _id: null,
          total: { $sum: 1 },
          pending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
          processing: { $sum: { $cond: [{ $in: ['$status', ['confirmed', 'processing', 'shipped']] }, 1, 0] } },
          delivered: { $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
          totalRevenue: { $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, '$sellerEarnings', 0] } }
        }}
      ])
    ]);

    let statData = statAgg && statAgg[0] ? statAgg[0] : {};
    const totalPages = Math.ceil(totalOrders / limit);

    res.render('sellerOrders', {
      title: 'My Orders - SellerHub',
      seller: req.seller,
      orders,
      stats: {
        total: statData.total || 0,
        pending: statData.pending || 0,
        processing: statData.processing || 0,
        delivered: statData.delivered || 0,
        cancelled: statData.cancelled || 0,
        totalRevenue: statData.totalRevenue || 0
      },
      currentPage: page,
      totalPages,
      totalOrders,
      hasNext: page < totalPages,
      hasPrev: page > 1,
      currentStatus: status,
      searchQuery: search
    });
  } catch (error) {
    console.error("❌ Orders Page Error:", error.message);
    res.status(500).send("Internal Server Error");
  }
});

// ====================== GET SINGLE ORDER (SELLER - PRIVACY SAFE) ======================
router.get('/orders/:id', async (req, res) => {
  if (!req.seller) {
    return res.status(401).json({ success: false, message: 'Not authenticated' });
  }

  try {
    const order = await Order.findOne({
      _id: req.params.id,
      seller: req.seller._id
    })
    .select('-customer -customerName -customerEmail -customerPhone -shippingAddress -paymentDetails')
    .lean();

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    res.json({ success: true, order });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ====================== UPDATE ORDER STATUS ======================
router.post('/orders/:id/status', async (req, res) => {
  if (!req.seller) {
    return res.status(401).json({ success: false, message: 'Not authenticated' });
  }

  try {
    const { status, note } = req.body;
    const validStatuses = ['pending', 'confirmed', 'processing', 'shipped', 'out_for_delivery', 'delivered', 'cancelled'];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    const order = await Order.findOne({
      _id: req.params.id,
      seller: req.seller._id
    });

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    order.status = status;
    order.statusHistory.push({
      status,
      note: note || `Status changed to ${status}`,
      updatedBy: req.seller._id,
      updatedByRole: 'SELLER'
    });

    if (status === 'delivered') {
      order.deliveredAt = new Date();
    }

    await order.save();
    res.json({ success: true, message: 'Status updated', order });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ====================== CANCEL ORDER ======================
router.post('/orders/:id/cancel', async (req, res) => {
  if (!req.seller) {
    return res.status(401).json({ success: false, message: 'Not authenticated' });
  }

  try {
    const { reason } = req.body;
    const order = await Order.findOne({
      _id: req.params.id,
      seller: req.seller._id
    });

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (!['pending', 'confirmed'].includes(order.status)) {
      return res.status(400).json({ success: false, message: 'Cannot cancel this order' });
    }

    order.status = 'cancelled';
    order.cancelledAt = new Date();
    order.cancelReason = reason || 'Cancelled by seller';
    order.statusHistory.push({
      status: 'cancelled',
      note: reason || 'Cancelled by seller',
      updatedBy: req.seller._id,
      updatedByRole: 'SELLER'
    });

    await order.save();
    res.json({ success: true, message: 'Order cancelled' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ====================== FORGOT PASSWORD ======================
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email || !validateEmail(email)) {
    return res.status(400).json({ success: false, message: "Valid email is required" });
  }

  try {
    const normalizedEmail = email.toLowerCase().trim();
    const seller = await Seller.findOne({ email: normalizedEmail });

    if (!seller) {
      return res.status(200).json({ success: true, message: "If this email exists, a reset link has been sent" });
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const tokenExpires = Date.now() + 30 * 60 * 1000;
    resetTokens.set(resetToken, { email: normalizedEmail, expires: tokenExpires });

    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const baseUrl = `${protocol}://${host}`;
    const resetLink = `${baseUrl}/seller/reset-password?token=${resetToken}`;

    try {
      await sendResetPasswordEmail(normalizedEmail, resetLink);
    } catch (emailError) {
      return res.status(500).json({ success: false, message: `Email service error: ${emailError.message}` });
    }

    res.json({ success: true, message: "If this email exists, a reset link has been sent" });

  } catch (error) {
    res.status(500).json({ success: false, message: error.message || "Failed to send reset link." });
  }
});

// ====================== GET RESET PASSWORD PAGE ======================
router.get('/reset-password', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).render('404', { message: 'Invalid reset link' });

  const stored = resetTokens.get(token);
  if (!stored) return res.status(400).render('404', { message: 'Reset link not found.' });
  if (stored.expires < Date.now()) {
    resetTokens.delete(token);
    return res.status(400).render('404', { message: 'Reset link expired.' });
  }

  res.render('sellerResetPassword', { token, error: null });
});

// ====================== POST RESET PASSWORD ======================
router.post('/reset-password', async (req, res) => {
  const { token, newPassword, confirmPassword } = req.body;
  if (!token || !newPassword || !confirmPassword) {
    return res.status(400).json({ success: false, message: "All fields are required" });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ success: false, message: "Passwords do not match" });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ success: false, message: "Password must be at least 6 characters" });
  }

  try {
    const stored = resetTokens.get(token);
    if (!stored) return res.status(400).json({ success: false, message: "Reset link not found" });
    if (stored.expires < Date.now()) {
      resetTokens.delete(token);
      return res.status(400).json({ success: false, message: "Reset link expired" });
    }

    const seller = await Seller.findOne({ email: stored.email });
    if (!seller) return res.status(404).json({ success: false, message: "Seller not found" });

    seller.password = newPassword;
    await seller.save();
    resetTokens.delete(token);

    res.json({ success: true, message: "Password reset successfully.", redirect: "/seller/signin" });

  } catch (error) {
    res.status(500).json({ success: false, message: error.message || "Failed to reset password" });
  }
});

// ====================== LOGOUT ======================
router.get('/logout', (req, res) => {
  res.clearCookie("token", { path: "/" });
  res.redirect('/');
});

router.post('/logout', (req, res) => {
  res.clearCookie("token", { path: "/" });
  res.status(200).json({ success: true, message: "Logged out successfully" });
});

// ====================== CLEANUP ======================
setInterval(() => {
  const now = Date.now();
  let otpCleaned = 0, tokenCleaned = 0;
  for (const [email, data] of otpStore.entries()) {
    if (data.expires < now) { otpStore.delete(email); otpCleaned++; }
  }
  for (const [token, data] of resetTokens.entries()) {
    if (data.expires < now) { resetTokens.delete(token); tokenCleaned++; }
  }
  if (otpCleaned > 0 || tokenCleaned > 0) {
    console.log(`🧹 Cleanup: ${otpCleaned} OTPs, ${tokenCleaned} tokens`);
  }
}, 5 * 60 * 1000);

module.exports = router;
