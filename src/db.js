const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Use pooler host if configured for reliable IPv4 connections
const host = process.env.POOLER_HOST || process.env.host;
const user = process.env.POOLER_USER || process.env.user;
const port = parseInt(process.env.DB_PORT || process.env.db_port || '5432', 10);
const database = process.env.database || 'postgres';
const password = process.env.password;

console.log(`[DB] Initializing PostgreSQL pool to ${host}:${port} as ${user}...`);

const pool = new Pool({
  host,
  port,
  database,
  user,
  password,
  ssl: {
    rejectUnauthorized: false
  },
  max: 20,
  idleTimeoutMillis: 60000,
  connectionTimeoutMillis: 15000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000
});

pool.on('error', (err) => {
  console.error('[DB] Pool idle connection warning:', err.message);
});

async function safeQuery(text, params) {
  try {
    return await pool.query(text, params);
  } catch (err) {
    if (err.message && (err.message.includes('Connection terminated') || err.message.includes('timeout'))) {
      console.warn('[DB] Connection dropped, retrying query once...');
      return await pool.query(text, params);
    }
    throw err;
  }
}

async function initDb() {
  const client = await pool.connect();
  try {
    console.log('[DB] Running database migrations & schema setup...');
    
    // Enable uuid extension if available
    await client.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`);

    // 1. Quizzes table
    await client.query(`
      CREATE TABLE IF NOT EXISTS quizzes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title VARCHAR(255) NOT NULL,
        description TEXT,
        cover_image TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // 2. Questions table
    await client.query(`
      CREATE TABLE IF NOT EXISTS questions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        quiz_id UUID NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
        question_text TEXT NOT NULL,
        type VARCHAR(20) DEFAULT 'quiz_4',
        time_limit INT DEFAULT 20,
        points INT DEFAULT 1000,
        slide_order INT NOT NULL,
        media_url TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // 3. Options table
    await client.query(`
      CREATE TABLE IF NOT EXISTS options (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        question_id UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
        option_text TEXT NOT NULL,
        is_correct BOOLEAN DEFAULT false,
        color_index INT NOT NULL
      );
    `);

    // 4. Game sessions table
    await client.query(`
      CREATE TABLE IF NOT EXISTS game_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        quiz_id UUID NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
        pin VARCHAR(8) NOT NULL,
        status VARCHAR(20) DEFAULT 'lobby',
        current_question_index INT DEFAULT -1,
        started_at TIMESTAMPTZ DEFAULT NOW(),
        ended_at TIMESTAMPTZ
      );
    `);

    // 5. Session players table
    await client.query(`
      CREATE TABLE IF NOT EXISTS session_players (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
        nickname VARCHAR(100) NOT NULL,
        score INT DEFAULT 0,
        streak INT DEFAULT 0,
        rank INT DEFAULT 0,
        joined_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // 6. Player answers table (detailed history tracking with foreign keys as requested)
    await client.query(`
      CREATE TABLE IF NOT EXISTS player_answers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
        player_id UUID NOT NULL REFERENCES session_players(id) ON DELETE CASCADE,
        question_id UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
        option_id UUID REFERENCES options(id) ON DELETE SET NULL,
        is_correct BOOLEAN DEFAULT false,
        time_taken_ms INT DEFAULT 0,
        points_awarded INT DEFAULT 0,
        answered_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Create helpful indices
    await client.query(`CREATE INDEX IF NOT EXISTS idx_questions_quiz_id ON questions(quiz_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_options_question_id ON options(question_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sessions_status ON game_sessions(status);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_player_answers_session ON player_answers(session_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_player_answers_player ON player_answers(player_id);`);

    console.log('[DB] Database schema and tables verified successfully!');
  } catch (err) {
    console.error('[DB] Schema init error:', err);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  query: safeQuery,
  initDb
};
