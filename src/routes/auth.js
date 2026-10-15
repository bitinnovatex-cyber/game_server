const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');

const router = express.Router();

// 1. PUBLIC: User/Admin Signup
router.post('/signup', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !email.trim()) {
      return res.status(400).json({ error: 'Email address is required' });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const cleanEmail = email.trim().toLowerCase();

    // Check if email already registered
    const existing = await db.query('SELECT id FROM users WHERE email = $1', [cleanEmail]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    // Hash password with bcrypt
    const passwordHash = await bcrypt.hash(password, 10);

    // Insert user with status = 'pending'
    const result = await db.query(
      `INSERT INTO users (email, password_hash, role, status)
       VALUES ($1, $2, 'admin', 'pending')
       RETURNING id, email, role, status, created_at`,
      [cleanEmail, passwordHash]
    );

    const newUser = result.rows[0];
    res.status(201).json({
      success: true,
      message: 'Signup successful! Your account is waiting for Super Admin approval.',
      user: {
        id: newUser.id,
        email: newUser.email,
        status: newUser.status
      }
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Failed to create user account' });
  }
});

// 2. PUBLIC: Login for Super Admin and Approved Users
router.post('/login', async (req, res) => {
  try {
    const { email, username, password } = req.body;
    const loginIdentifier = (email || username || '').trim().toLowerCase();
    const adminUsername = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';

    if (!loginIdentifier || !password) {
      return res.status(400).json({ error: 'Email/Username and password are required' });
    }

    // A. Check Super Admin credentials from .env
    if (loginIdentifier === adminUsername && password === adminPassword) {
      const token = jwt.sign(
        { userId: 'superadmin', email: process.env.ADMIN_USERNAME || 'admin', role: 'superadmin', status: 'approved' },
        process.env.JWT_SECRET || 'fallback_secret',
        { expiresIn: '7d' }
      );
      return res.json({
        success: true,
        token,
        user: { userId: 'superadmin', email: process.env.ADMIN_USERNAME || 'admin', role: 'superadmin', status: 'approved' }
      });
    }

    // B. Check Users from DB
    const uRes = await db.query(
      'SELECT id, email, password_hash, role, status FROM users WHERE email = $1',
      [loginIdentifier]
    );

    if (uRes.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = uRes.rows[0];

    // Verify bcrypt password
    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Enforce approval status
    if (user.status === 'pending') {
      return res.status(403).json({
        error: 'Your account is waiting for Super Admin approval before you can log in.',
        status: 'pending'
      });
    }
    if (user.status === 'rejected') {
      return res.status(403).json({
        error: 'Your account access request was rejected by the Super Admin.',
        status: 'rejected'
      });
    }

    // Sign JWT token for approved user
    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role || 'admin', status: user.status },
      process.env.JWT_SECRET || 'fallback_secret',
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      user: {
        userId: user.id,
        email: user.email,
        role: user.role || 'admin',
        status: user.status
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// 3. PROTECTED: Get current authenticated user profile
router.get('/me', requireAuth, (req, res) => {
  res.json({
    authenticated: true,
    user: req.user
  });
});

// 4. SUPER ADMIN: List all admin users for approval/rejection
router.get('/users', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, email, role, status, created_at,
              (SELECT COUNT(*)::int FROM quizzes WHERE user_id = users.id) as quiz_count
       FROM users
       ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Fetch users error:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// 5. SUPER ADMIN: Approve or Reject an admin user
router.put('/users/:id/status', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['approved', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be approved, rejected, or pending' });
    }

    const result = await db.query(
      `UPDATE users
       SET status = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, email, role, status`,
      [status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      success: true,
      message: `User status updated to ${status}`,
      user: result.rows[0]
    });
  } catch (err) {
    console.error('Update user status error:', err);
    res.status(500).json({ error: 'Failed to update user status' });
  }
});

module.exports = router;
