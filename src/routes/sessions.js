const express = require('express');
const { requireAuth } = require('../middleware/auth');
const db = require('../db');
const gameManager = require('../gameManager');

const router = express.Router();

// 1. PUBLIC: Check if there is an active quiz session currently running
// Checks in-memory gameManager first for instant 0ms response, with DB fallback
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
    // Don't crash or return 500, gracefully return inactive if DB is sleeping
    res.json({ active: false });
  }
});

// 2. ADMIN: Launch a new live quiz session
router.post('/launch', requireAuth, async (req, res) => {
  const { quiz_id } = req.body;
  if (!quiz_id) {
    return res.status(400).json({ error: 'quiz_id is required' });
  }

  try {
    // Check quiz exists and has questions
    const quizRes = await db.query('SELECT * FROM quizzes WHERE id = $1', [quiz_id]);
    if (quizRes.rows.length === 0) {
      return res.status(404).json({ error: 'Quiz not found' });
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
    optionsRes.rows.forEach(opt => {
      if (!optionsByQ[opt.question_id]) optionsByQ[opt.question_id] = [];
      optionsByQ[opt.question_id].push(opt);
    });

    questions.forEach(q => {
      q.options = optionsByQ[q.id] || [];
    });

    // Close any previous open/lobby sessions
    await db.query(`UPDATE game_sessions SET status = 'finished', ended_at = NOW() WHERE status IN ('lobby', 'active')`);

    // Generate 6-digit game PIN
    const pin = Math.floor(100000 + Math.random() * 900000).toString();

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
      quiz: quizRes.rows[0],
      questions
    });

    res.json({
      success: true,
      session: {
        id: session.id,
        pin,
        title: quizRes.rows[0].title,
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
    const result = await db.query(`
      SELECT s.id, s.pin, s.status, s.started_at, s.ended_at,
             q.title as quiz_title,
             COUNT(p.id)::int as total_players,
             COALESCE(MAX(p.score), 0)::int as top_score,
             COALESCE(AVG(p.score), 0)::int as avg_score
      FROM game_sessions s
      JOIN quizzes q ON q.id = s.quiz_id
      LEFT JOIN session_players p ON p.session_id = s.id
      WHERE s.status = 'finished'
      GROUP BY s.id, q.title
      ORDER BY s.started_at DESC
      LIMIT 50
    `);
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
