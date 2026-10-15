const express = require('express');
const { requireAuth } = require('../middleware/auth');
const db = require('../db');

const router = express.Router();

// 1. Get all quizzes
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT q.*, 
        (SELECT COUNT(*)::int FROM questions WHERE quiz_id = q.id) as question_count
      FROM quizzes q
      ORDER BY q.updated_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching quizzes:', err);
    res.status(500).json({ error: 'Failed to fetch quizzes' });
  }
});

// 2. Get single quiz with all slides and options
router.get('/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const quizResult = await db.query('SELECT * FROM quizzes WHERE id = $1', [id]);
    if (quizResult.rows.length === 0) {
      return res.status(404).json({ error: 'Quiz not found' });
    }

    const quiz = quizResult.rows[0];

    // Fetch questions ordered by slide_order
    const questionsResult = await db.query(
      'SELECT * FROM questions WHERE quiz_id = $1 ORDER BY slide_order ASC',
      [id]
    );

    const questions = questionsResult.rows;

    // Fetch all options for these questions
    if (questions.length > 0) {
      const questionIds = questions.map(q => q.id);
      const optionsResult = await db.query(
        'SELECT * FROM options WHERE question_id = ANY($1::uuid[]) ORDER BY color_index ASC',
        [questionIds]
      );

      const optionsByQ = {};
      optionsResult.rows.forEach(opt => {
        if (!optionsByQ[opt.question_id]) optionsByQ[opt.question_id] = [];
        optionsByQ[opt.question_id].push(opt);
      });

      questions.forEach(q => {
        q.options = optionsByQ[q.id] || [];
      });
    }

    quiz.questions = questions;
    res.json(quiz);
  } catch (err) {
    console.error('Error fetching quiz details:', err);
    res.status(500).json({ error: 'Failed to fetch quiz details' });
  }
});

// 3. Create a new quiz with slides
router.post('/', requireAuth, async (req, res) => {
  const { title, description, cover_image, questions = [] } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Title is required' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const quizRes = await client.query(
      `INSERT INTO quizzes (title, description, cover_image) 
       VALUES ($1, $2, $3) RETURNING *`,
      [title.trim(), description || '', cover_image || '']
    );
    const newQuiz = quizRes.rows[0];

    // Insert questions and options
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const qRes = await client.query(
        `INSERT INTO questions (quiz_id, question_text, type, time_limit, points, slide_order, media_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          newQuiz.id,
          q.question_text || 'Untitled Question',
          q.type || 'quiz_4',
          q.time_limit || 20,
          q.points || 1000,
          i,
          q.media_url || ''
        ]
      );
      const questionId = qRes.rows[0].id;

      const opts = q.options || [];
      for (let j = 0; j < opts.length; j++) {
        const opt = opts[j];
        await client.query(
          `INSERT INTO options (question_id, option_text, is_correct, color_index)
           VALUES ($1, $2, $3, $4)`,
          [questionId, opt.option_text || '', !!opt.is_correct, j]
        );
      }
    }

    await client.query('COMMIT');
    res.status(201).json({ success: true, quiz: newQuiz });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error creating quiz:', err);
    res.status(500).json({ error: 'Failed to create quiz' });
  } finally {
    client.release();
  }
});

// 4. Update an existing quiz with slides
router.put('/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { title, description, cover_image, questions = [] } = req.body;

  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Title is required' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE quizzes SET title = $1, description = $2, cover_image = $3, updated_at = NOW()
       WHERE id = $4`,
      [title.trim(), description || '', cover_image || '', id]
    );

    // Delete old questions (options cascade deleted)
    await client.query('DELETE FROM questions WHERE quiz_id = $1', [id]);

    // Reinsert updated questions & options
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const qRes = await client.query(
        `INSERT INTO questions (quiz_id, question_text, type, time_limit, points, slide_order, media_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          id,
          q.question_text || 'Untitled Question',
          q.type || 'quiz_4',
          q.time_limit || 20,
          q.points || 1000,
          i,
          q.media_url || ''
        ]
      );
      const questionId = qRes.rows[0].id;

      const opts = q.options || [];
      for (let j = 0; j < opts.length; j++) {
        const opt = opts[j];
        await client.query(
          `INSERT INTO options (question_id, option_text, is_correct, color_index)
           VALUES ($1, $2, $3, $4)`,
          [questionId, opt.option_text || '', !!opt.is_correct, j]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ success: true, message: 'Quiz updated successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error updating quiz:', err);
    res.status(500).json({ error: 'Failed to update quiz' });
  } finally {
    client.release();
  }
});

// 5. Delete a quiz
router.delete('/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    await db.query('DELETE FROM quizzes WHERE id = $1', [id]);
    res.json({ success: true, message: 'Quiz deleted successfully' });
  } catch (err) {
    console.error('Error deleting quiz:', err);
    res.status(500).json({ error: 'Failed to delete quiz' });
  }
});

// 6. AI Question Generator using Gemini API
router.post('/generate-ai', requireAuth, async (req, res) => {
  const { topic, count = 5, type = 'quiz_4' } = req.body;
  const apiKey = process.env.gemini_api_key;

  if (!apiKey) {
    return res.status(500).json({ error: 'Gemini API key is not configured in environment' });
  }
  if (!topic || !topic.trim()) {
    return res.status(400).json({ error: 'Topic or content prompt is required' });
  }

  const numQuestions = Math.min(Math.max(parseInt(count, 10) || 5, 1), 20);
  const prompt = `You are a quiz master creating an engaging, high-energy live quiz for PS SkillSift.
Topic/Source Material: "${topic}".
Generate ${numQuestions} engaging, accurate questions.
Question Type: ${type === 'quiz_2' ? 'True/False (2 choices)' : 'Multiple Choice (4 choices)'}.

Return ONLY a pure JSON array (no markdown code blocks, no backticks, no explanations) where each item has this exact schema:
[
  {
    "question_text": "The question text here",
    "type": "${type}",
    "time_limit": 20,
    "points": 1000,
    "options": [
      { "option_text": "Choice 1", "is_correct": true },
      { "option_text": "Choice 2", "is_correct": false },
      ${type === 'quiz_4' ? '{ "option_text": "Choice 3", "is_correct": false },\n      { "option_text": "Choice 4", "is_correct": false }' : ''}
    ]
  }
]
Rules:
- For 4-choice questions, provide exactly 4 distinct options with exactly one correct option.
- For 2-choice questions, provide "True" and "False" as the two options with one marked correct.
- Make the questions fun, educational, and clear.`;

  try {
    // Use gemini-3.5-flash-lite (fast & lightweight)
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${apiKey}`;
    
    let aiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          responseMimeType: 'application/json'
        }
      })
    });

    if (!aiRes.ok) {
      // Fallback to gemini-flash-lite-latest
      const fallbackUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${apiKey}`;
      aiRes = await fetch(fallbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.7,
            responseMimeType: 'application/json'
          }
        })
      });
    }

    if (!aiRes.ok) {
      const errData = await aiRes.text();
      console.error('Gemini API call failed:', errData);
      return res.status(502).json({ error: 'AI generation service failed. Check API key.' });
    }

    const aiData = await aiRes.json();
    let text = aiData.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return res.status(500).json({ error: 'Empty response from Gemini AI' });
    }

    // Clean up potential markdown wrapper
    text = text.trim();
    if (text.startsWith('```json')) {
      text = text.substring(7);
    }
    if (text.startsWith('```')) {
      text = text.substring(3);
    }
    if (text.endsWith('```')) {
      text = text.substring(0, text.length - 3);
    }

    const questions = JSON.parse(text.trim());
    res.json({ success: true, questions });
  } catch (err) {
    console.error('Error generating AI questions:', err);
    res.status(500).json({ error: 'Failed to generate questions with AI: ' + err.message });
  }
});

module.exports = router;
