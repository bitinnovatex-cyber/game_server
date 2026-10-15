const express = require('express');
const { requireAuth } = require('../middleware/auth');
const db = require('../db');
const gameManager = require('../gameManager');

const router = express.Router();

// 1. PUBLIC: Validate and lookup a live session by its 6-digit PIN
router.get('/pin/:pin', async (req, res) => {
  const { pin } = req.params;
  const cleanPin = (pin || '').trim();

  if (!/^\d{6}$/.test(cleanPin)) {
    return res.status(400).json({ valid: false, error: 'Please enter a valid 6-digit PIN.' });
  }

  try {
    // 1. Check in-memory game engine
    const memoryGame = gameManager.getGameByPin(cleanPin);
    if (memoryGame) {
      return res.json({
        valid: true,
        session: {
          id: memoryGame.id,
          pin: memoryGame.pin,
          status: memoryGame.state === 'podium' ? 'finished' : memoryGame.state,
          quizTitle: memoryGame.quiz?.title || 'Live Quiz',
          playerCount: memoryGame.players ? memoryGame.players.size : 0
        }
      });
    }

    // 2. Fallback to active DB sessions
    const result = await db.query(`
      SELECT s.id, s.pin, s.status,
             q.title as quiz_title,
             (SELECT COUNT(*)::int FROM session_players WHERE session_id = s.id) as player_count
      FROM game_sessions s
      JOIN quizzes q ON q.id = s.quiz_id
      WHERE s.pin = $1 AND s.status IN ('lobby', 'active')
      ORDER BY s.started_at DESC
      LIMIT 1
    `, [cleanPin]);

    if (result.rows.length === 0) {
      return res.status(404).json({ valid: false, error: 'No active quiz found with this PIN. Check the PIN and try again.' });
    }

    const session = result.rows[0];
    res.json({
      valid: true,
      session: {
        id: session.id,
        pin: session.pin,
        status: session.status,
        quizTitle: session.quiz_title,
        playerCount: session.player_count
      }
    });
  } catch (err) {
    console.error('Error looking up session by PIN:', err.message);
    res.status(500).json({ valid: false, error: 'Server error checking PIN' });
  }
});

// 1.1 PUBLIC: Legacy check if any active quiz exists (kept for compatibility)
router.get('/active', async (req, res) => {
  try {
    const memoryGame = gameManager.getActiveGame();
    if (memoryGame) {
      return res.json({
        active: true,
        session: {
          id: memoryGame.id,
          pin: memoryGame.pin,
          status: memoryGame.state === 'podium' ? 'finished' : 'active',
          quizTitle: memoryGame.quiz?.title || 'Live Quiz',
          playerCount: memoryGame.players ? memoryGame.players.size : 0
        }
      });
    }

    const result = await db.query(`
      SELECT s.id, s.pin, s.status, s.current_question_index, s.started_at,
             q.title as quiz_title,
             (SELECT COUNT(*)::int FROM session_players WHERE session_id = s.id) as player_count
      FROM game_sessions s
      JOIN quizzes q ON q.id = s.quiz_id
      WHERE s.status IN ('lobby', 'active')
      ORDER BY s.started_at DESC
      LIMIT 1
    `);

    if (result.rows.length === 0) {
      return res.json({ active: false });
    }

    const session = result.rows[0];
    res.json({
      active: true,
      session: {
        id: session.id,
        pin: session.pin,
        status: session.status,
        quizTitle: session.quiz_title,
        playerCount: session.player_count
      }
    });
  } catch (err) {
    console.error('Error checking active session:', err.message);
    res.json({ active: false });
  }
});

// 2. ADMIN: Launch a new live quiz session
router.post('/launch', requireAuth, async (req, res) => {
  if (req.user.role === 'superadmin') {
    return res.status(403).json({ error: 'Super Admin has read-only access. Please log in with an Admin account to host quizzes.' });
  }

  const { quiz_id } = req.body;
  if (!quiz_id) {
    return res.status(400).json({ error: 'quiz_id is required' });
  }

  try {
    // Check quiz exists and user is owner
    const quizRes = await db.query('SELECT * FROM quizzes WHERE id = $1', [quiz_id]);
    if (quizRes.rows.length === 0) {
      return res.status(404).json({ error: 'Quiz not found' });
    }

    const quiz = quizRes.rows[0];
    if (quiz.user_id && quiz.user_id !== req.user.userId) {
      return res.status(403).json({ error: 'Unauthorized: You can only host your own quizzes.' });
    }

    const questionsRes = await db.query(
      'SELECT * FROM questions WHERE quiz_id = $1 ORDER BY slide_order ASC',
      [quiz_id]
    );

    if (questionsRes.rows.length === 0) {
      return res.status(400).json({ error: 'Cannot host a quiz with no questions/slides!' });
    }

    const questions = questionsRes.rows;
    const questionIds = questions.map(q => q.id);

    const optionsRes = await db.query(
      'SELECT * FROM options WHERE question_id = ANY($1::uuid[]) ORDER BY color_index ASC',
      [questionIds]
    );

    const optionsByQ = {};
    optionsRes.forEach ? optionsRes.rows.forEach(opt => {
      if (!optionsByQ[opt.question_id]) optionsByQ[opt.question_id] = [];
      optionsByQ[opt.question_id].push(opt);
    }) : null;

    questions.forEach(q => {
      q.options = optionsByQ[q.id] || [];
    });

    // Close any previous open session for THIS quiz only (allowing other hosts to run concurrently)
    await db.query(`UPDATE game_sessions SET status = 'finished', ended_at = NOW() WHERE quiz_id = $1 AND status IN ('lobby', 'active')`, [quiz_id]);

    // Generate unique 6-digit game PIN (non-colliding)
    let pin = '';
    let isUnique = false;
    for (let attempts = 0; attempts < 10; attempts++) {
      const candidatePin = Math.floor(100000 + Math.random() * 900000).toString();
      if (!gameManager.getGameByPin(candidatePin)) {
        const check = await db.query(`SELECT id FROM game_sessions WHERE pin = $1 AND status IN ('lobby', 'active')`, [candidatePin]);
        if (check.rows.length === 0) {
          pin = candidatePin;
          isUnique = true;
          break;
        }
      }
    }
    if (!isUnique) {
      pin = Math.floor(100000 + Math.random() * 900000).toString();
    }

    // Insert new game_session
    const sessionRes = await db.query(
      `INSERT INTO game_sessions (quiz_id, pin, status, current_question_index)
       VALUES ($1, $2, 'lobby', -1) RETURNING *`,
      [quiz_id, pin]
    );
    const session = sessionRes.rows[0];

    // Initialize in-memory Game Engine
    gameManager.createGame(session.id, {
      id: session.id,
      pin,
      quiz,
      questions
    });

    res.json({
      success: true,
      session: {
        id: session.id,
        pin,
        title: quiz.title,
        status: 'lobby'
      }
    });
  } catch (err) {
    console.error('Error launching session:', err);
    res.status(500).json({ error: 'Failed to launch quiz session' });
  }
});

// 3. ADMIN: End an active session
router.post('/:id/end', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    await db.query(`UPDATE game_sessions SET status = 'finished', ended_at = NOW() WHERE id = $1`, [id]);
    gameManager.endGame(id);
    res.json({ success: true, message: 'Session ended' });
  } catch (err) {
    console.error('Error ending session:', err);
    res.status(500).json({ error: 'Failed to end session' });
  }
});

// 4. ADMIN: Get past session history
router.get('/history', requireAuth, async (req, res) => {
  try {
    let result;
    if (req.user.role === 'superadmin') {
      result = await db.query(`
        SELECT s.id, s.pin, s.status, s.started_at, s.ended_at,
               q.title as quiz_title,
               COALESCE(u.email, 'Admin') as creator_email,
               COUNT(p.id)::int as total_players,
               COALESCE(MAX(p.score), 0)::int as top_score,
               COALESCE(AVG(p.score), 0)::int as avg_score
        FROM game_sessions s
        JOIN quizzes q ON q.id = s.quiz_id
        LEFT JOIN users u ON q.user_id = u.id
        LEFT JOIN session_players p ON p.session_id = s.id
        WHERE s.status = 'finished'
        GROUP BY s.id, q.title, u.email
        ORDER BY s.started_at DESC
        LIMIT 50
      `);
    } else {
      result = await db.query(`
        SELECT s.id, s.pin, s.status, s.started_at, s.ended_at,
               q.title as quiz_title,
               COUNT(p.id)::int as total_players,
               COALESCE(MAX(p.score), 0)::int as top_score,
               COALESCE(AVG(p.score), 0)::int as avg_score
        FROM game_sessions s
        JOIN quizzes q ON q.id = s.quiz_id
        LEFT JOIN session_players p ON p.session_id = s.id
        WHERE s.status = 'finished' AND q.user_id = $1
        GROUP BY s.id, q.title
        ORDER BY s.started_at DESC
        LIMIT 50
      `, [req.user.userId]);
    }
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching history:', err);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// 5. ADMIN: Get detailed report of a completed session
router.get('/:id/report', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const sessionRes = await db.query(`
      SELECT s.*, q.title as quiz_title
      FROM game_sessions s
      JOIN quizzes q ON q.id = s.quiz_id
      WHERE s.id = $1
    `, [id]);

    if (sessionRes.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const session = sessionRes.rows[0];

    // Players in this session ordered by score
    const playersRes = await db.query(`
      SELECT * FROM session_players
      WHERE session_id = $1
      ORDER BY score DESC, nickname ASC
    `, [id]);

    // Student answers with question and option details
    const answersRes = await db.query(`
      SELECT pa.*, p.nickname, q.question_text, q.slide_order, o.option_text as chosen_option_text
      FROM player_answers pa
      JOIN session_players p ON p.id = pa.player_id
      JOIN questions q ON q.id = pa.question_id
      LEFT JOIN options o ON o.id = pa.option_id
      WHERE pa.session_id = $1
      ORDER BY q.slide_order ASC, pa.points_awarded DESC
    `, [id]);

    res.json({
      session,
      players: playersRes.rows,
      answers: answersRes.rows
    });
  } catch (err) {
    console.error('Error fetching session report:', err);
    res.status(500).json({ error: 'Failed to fetch report' });
  }
});

module.exports = router;
