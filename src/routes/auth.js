const express = require('express');
const jwt = require('jsonwebtoken');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const adminUsername = process.env.ADMIN_USERNAME || 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  // Secure comparison without exposing env contents to client
  if (username === adminUsername && password === adminPassword) {
    const token = jwt.sign(
      { username: adminUsername, role: 'admin' },
      process.env.JWT_SECRET || 'fallback_secret',
      { expiresIn: '7d' }
    );
    return res.json({
      success: true,
      token,
      user: { username: adminUsername, role: 'admin' }
    });
  }

  return res.status(401).json({ error: 'Invalid username or password' });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({
    authenticated: true,
    user: req.user
  });
});

module.exports = router;
