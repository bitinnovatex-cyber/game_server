// Version 1.0 - Stable Baseline Release
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // Handles SSL clock skew for API fetches
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require('./db');
const gameManager = require('./gameManager');
const authRoutes = require('./routes/auth');
const quizRoutes = require('./routes/quizzes');
const sessionRoutes = require('./routes/sessions');

const app = express();
const server = http.createServer(app);

// Configure Socket.io with CORS
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  },
  pingTimeout: 30000,
  pingInterval: 15000
});

gameManager.setIO(io);

// Middleware
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/quizzes', quizRoutes);
app.use('/api/sessions', sessionRoutes);

// Socket.io Real-time Handlers
io.on('connection', (socket) => {
  // 1. Participant joins a game lobby
  socket.on('join-lobby', async ({ sessionId, pin, nickname, playerId }, callback) => {
    try {
      const targetId = sessionId || pin;
      const res = await gameManager.addPlayer(targetId, socket, nickname, playerId);
      if (typeof callback === 'function') {
        callback(res);
      }
    } catch (err) {
      console.error('Socket join-lobby error:', err);
      if (typeof callback === 'function') callback({ success: false, error: 'Failed to join' });
    }
  });

  // 2. Host joins room to control game
  socket.on('host-join', ({ sessionId }, callback) => {
    const game = gameManager.getGame(sessionId);
    if (!game) {
      if (typeof callback === 'function') callback({ success: false, error: 'Session not active' });
      return;
    }
    socket.join(`session:${sessionId}`);
    socket.isHost = true;
    console.log(`[Socket] Host connected for session ${sessionId}`);

    // Send current game state to host
    const playerList = Array.from(game.players.values()).map(p => ({
      id: p.id,
      nickname: p.nickname,
      score: p.score
    }));

    if (typeof callback === 'function') {
      callback({
        success: true,
        game: {
          id: game.id,
          pin: game.pin,
          title: game.quiz.title,
          state: game.state,
          playerCount: playerList.length,
          players: playerList,
          currentQIndex: game.currentQIndex,
          totalQuestions: game.questions.length
        }
      });
    }
  });

  // 3. Host starts quiz
  socket.on('host-start-quiz', ({ sessionId }) => {
    gameManager.startQuiz(sessionId);
  });

  // 4. Host triggers next question
  socket.on('host-next-question', ({ sessionId }) => {
    gameManager.nextQuestion(sessionId);
  });

  // 5. Host skips / ends question early
  socket.on('host-skip-question', ({ sessionId }) => {
    gameManager.finishQuestion(sessionId);
  });

  // 6. Host shows leaderboard
  socket.on('host-show-leaderboard', ({ sessionId }) => {
    gameManager.showLeaderboard(sessionId);
  });

  // 7. Host shows final podium
  socket.on('host-show-podium', ({ sessionId }) => {
    gameManager.showPodium(sessionId);
  });

  // 7.5 Host kicks a player from the game
  socket.on('host-kick-player', async ({ sessionId, playerId }, callback) => {
    try {
      const res = await gameManager.kickPlayer(sessionId, playerId);
      if (typeof callback === 'function') callback(res);
    } catch (err) {
      console.error('Socket host-kick-player error:', err);
      if (typeof callback === 'function') callback({ success: false, error: 'Failed to kick player' });
    }
  });

  // 8. Participant submits an answer
  socket.on('submit-answer', async ({ sessionId, playerId, optionId }, callback) => {
    try {
      const res = await gameManager.submitAnswer(sessionId, playerId, optionId);
      if (typeof callback === 'function') callback(res);
    } catch (err) {
      console.error('Socket submit-answer error:', err);
      if (typeof callback === 'function') callback({ success: false, error: 'Submission failed' });
    }
  });

  // Disconnect handler - keep players in memory so mobile reconnects don't lose state
  socket.on('disconnect', (reason) => {
    // Player remains registered so they can reconnect without duplicate avatars
    console.log(`[Socket] Client disconnected (${socket.id}): ${reason}`);
  });
});

const PORT = process.env.SERVER_PORT || (process.env.PORT && process.env.PORT !== '5432' ? process.env.PORT : 5000);

async function startServer() {
  try {
    await db.initDb();
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`===============================================`);
      console.log(`🚀 PS SkillSift Live Server running on port ${PORT}`);
      console.log(`🌐 Public / Network address: http://0.0.0.0:${PORT}`);
      console.log(`📡 WebSocket ready for 500+ participants`);
      console.log(`🔐 Admin JWT Auth configured`);
      console.log(`===============================================`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

startServer();
