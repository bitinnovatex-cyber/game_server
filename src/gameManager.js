const db = require('./db');

class GameManager {
  constructor() {
    // In-memory games indexed by sessionId:
    // sessionId -> { id, pin, quiz, questions, currentQIndex, state, players: Map(), timer, qStartTime }
    this.games = new Map();
    this.io = null;
  }

  setIO(io) {
    this.io = io;
  }

  createGame(sessionId, data) {
    // Stop any existing timer
    if (this.games.has(sessionId)) {
      this.clearGameTimer(sessionId);
    }

    const game = {
      id: sessionId,
      pin: data.pin,
      quiz: data.quiz,
      questions: data.questions,
      currentQIndex: -1,
      state: 'lobby', // 'lobby' | 'intro' | 'question' | 'result' | 'leaderboard' | 'podium'
      players: new Map(), // playerId -> { id, socketId, nickname, score, streak, rank, currentAnswer }
      timer: null,
      timeLeft: 0,
      qStartTime: null,
      answerStats: [0, 0, 0, 0] // counts per color_index
    };

    this.games.set(sessionId, game);
    console.log(`[GameManager] Game created for session ${sessionId} (PIN: ${game.pin}) with ${game.questions.length} questions`);
    return game;
  }

  getGame(sessionId) {
    return this.games.get(sessionId);
  }

  getGameByPin(pin) {
    if (!pin) return null;
    const cleanPin = String(pin).trim();
    for (const game of this.games.values()) {
      if (game.pin === cleanPin && game.state !== 'podium' && game.state !== 'finished') {
        return game;
      }
    }
    return null;
  }

  getActiveGame() {
    for (const game of this.games.values()) {
      if (game.state !== 'podium' && game.state !== 'finished') {
        return game;
      }
    }
    return null;
  }

  clearGameTimer(sessionId) {
    const game = this.games.get(sessionId);
    if (game && game.timer) {
      clearInterval(game.timer);
      game.timer = null;
    }
  }

  async addPlayer(sessionId, socket, nickname, existingPlayerId = null) {
    let game = this.games.get(sessionId);
    if (!game) {
      // Try finding by PIN or check active
      for (const g of this.games.values()) {
        if (g.pin === sessionId || g.id === sessionId) {
          game = g;
          break;
        }
      }
    }

    if (!game) {
      return { success: false, error: 'Quiz session not found or inactive' };
    }

    const cleanName = (nickname || 'Player').trim().slice(0, 30);

    // 1. Check if player with this ID or identical Nickname already exists
    let player = null;
    if (existingPlayerId && game.players.has(existingPlayerId)) {
      player = game.players.get(existingPlayerId);
    } else {
      for (const p of game.players.values()) {
        if (p.nickname.toLowerCase() === cleanName.toLowerCase()) {
          player = p;
          break;
        }
      }
    }

    if (player) {
      // Re-attach existing player socket without duplicating them!
      console.log(`[GameManager] Re-attaching existing player: "${player.nickname}" (${player.id})`);
      player.socketId = socket.id;
      socket.playerId = player.id;
      socket.sessionId = game.id;
      socket.join(`session:${game.id}`);

      // Build current question payload if mid-game
      let currentQData = null;
      if (game.state === 'question' && game.currentQIndex >= 0) {
        const currentQ = game.questions[game.currentQIndex];
        const sanitizedOptions = (currentQ.options || []).map((o, idx) => ({
          id: o.id,
          option_text: o.option_text,
          color_index: o.color_index !== undefined ? o.color_index : idx
        }));
        currentQData = {
          questionIndex: game.currentQIndex,
          totalQuestions: game.questions.length,
          questionText: currentQ.question_text,
          timeLimit: game.timeLeft,
          options: sanitizedOptions
        };
      }

      return {
        success: true,
        player: {
          id: player.id,
          nickname: player.nickname,
          sessionId: game.id,
          pin: game.pin
        },
        gameState: game.state,
        currentQIndex: game.currentQIndex,
        currentQuestion: currentQData,
        timeLeft: game.timeLeft,
        answered: player.currentAnswer !== null
      };
    }

    // 2. New player: Persist player in DB
    try {
      const pRes = await db.query(
        `INSERT INTO session_players (session_id, nickname, score, streak)
         VALUES ($1, $2, 0, 0) RETURNING id`,
        [game.id, cleanName]
      );
      const playerId = pRes.rows[0].id;

      player = {
        id: playerId,
        socketId: socket.id,
        nickname: cleanName,
        score: 0,
        streak: 0,
        rank: game.players.size + 1,
        currentAnswer: null
      };

      game.players.set(playerId, player);
      socket.playerId = playerId;
      socket.sessionId = game.id;
      socket.join(`session:${game.id}`);

      console.log(`[GameManager] New Player joined: "${cleanName}" (${playerId}) in session ${game.id}. Total: ${game.players.size}`);

      // Broadcast updated roster to host and lobby
      this.broadcastLobbyUpdate(game.id);

      return {
        success: true,
        player: {
          id: playerId,
          nickname: cleanName,
          sessionId: game.id,
          pin: game.pin
        },
        gameState: game.state,
        currentQIndex: game.currentQIndex
      };
    } catch (err) {
      console.error('Error adding player to db:', err.message);
      return { success: false, error: 'Could not register player' };
    }
  }

  broadcastLobbyUpdate(sessionId) {
    const game = this.games.get(sessionId);
    if (!game) return;

    const playerList = Array.from(game.players.values()).map(p => ({
      id: p.id,
      nickname: p.nickname,
      score: p.score
    }));

    this.io.to(`session:${sessionId}`).emit('lobby-update', {
      playerCount: playerList.length,
      players: playerList,
      state: game.state,
      quizTitle: game.quiz.title,
      pin: game.pin
    });
  }

  async startQuiz(sessionId) {
    const game = this.games.get(sessionId);
    if (!game || game.questions.length === 0) return;

    console.log(`[GameManager] Starting quiz for session ${sessionId}`);
    await db.query(`UPDATE game_sessions SET status = 'active' WHERE id = $1`, [sessionId]);

    this.nextQuestion(sessionId);
  }

  nextQuestion(sessionId) {
    const game = this.games.get(sessionId);
    if (!game) return;

    this.clearGameTimer(sessionId);
    game.currentQIndex += 1;

    if (game.currentQIndex >= game.questions.length) {
      // Quiz finished -> Show podium
      this.showPodium(sessionId);
      return;
    }

    const currentQ = game.questions[game.currentQIndex];
    game.state = 'intro';
    game.answerStats = [0, 0, 0, 0];

    // Reset player answers for this question
    game.players.forEach(p => {
      p.currentAnswer = null;
    });

    // 1. Intro stage (3 seconds countdown: "Question X of Y")
    this.io.to(`session:${sessionId}`).emit('question-intro', {
      questionIndex: game.currentQIndex,
      totalQuestions: game.questions.length,
      questionText: currentQ.question_text,
      timeLimit: currentQ.time_limit,
      type: currentQ.type
    });

    let introSeconds = 3;
    const introInterval = setInterval(() => {
      introSeconds -= 1;
      this.io.to(`session:${sessionId}`).emit('intro-tick', { timeLeft: introSeconds });
      if (introSeconds <= 0) {
        clearInterval(introInterval);
        this.launchQuestion(sessionId);
      }
    }, 1000);
  }

  launchQuestion(sessionId) {
    const game = this.games.get(sessionId);
    if (!game) return;

    const currentQ = game.questions[game.currentQIndex];
    game.state = 'question';
    game.timeLeft = currentQ.time_limit || 20;
    game.qStartTime = Date.now();

    // Security: sanitize options for players (DO NOT send is_correct to players!)
    const sanitizedOptions = (currentQ.options || []).map((o, idx) => ({
      id: o.id,
      option_text: o.option_text,
      color_index: o.color_index !== undefined ? o.color_index : idx
    }));

    // Broadcast question to everyone
    this.io.to(`session:${sessionId}`).emit('question-start', {
      questionIndex: game.currentQIndex,
      totalQuestions: game.questions.length,
      questionText: currentQ.question_text,
      timeLimit: game.timeLeft,
      type: currentQ.type,
      mediaUrl: currentQ.media_url,
      options: sanitizedOptions
    });

    // Start timer interval
    game.timer = setInterval(() => {
      game.timeLeft -= 1;

      this.io.to(`session:${sessionId}`).emit('timer-tick', {
        timeLeft: game.timeLeft,
        answeredCount: this.getAnsweredCount(game)
      });

      if (game.timeLeft <= 0) {
        this.clearGameTimer(sessionId);
        this.finishQuestion(sessionId);
      }
    }, 1000);
  }

  getAnsweredCount(game) {
    let count = 0;
    game.players.forEach(p => {
      if (p.currentAnswer !== null) count++;
    });
    return count;
  }

  async submitAnswer(sessionId, playerId, optionId) {
    const game = this.games.get(sessionId);
    if (!game || game.state !== 'question') {
      return { success: false, error: 'Question not accepting answers' };
    }

    const player = game.players.get(playerId);
    if (!player) {
      return { success: false, error: 'Player not recognized' };
    }

    if (player.currentAnswer !== null) {
      return { success: false, error: 'Already answered' };
    }

    const currentQ = game.questions[game.currentQIndex];
    const timeTakenMs = Math.max(0, Date.now() - game.qStartTime);
    const chosenOption = (currentQ.options || []).find(o => o.id === optionId);

    const isCorrect = chosenOption ? !!chosenOption.is_correct : false;
    let pointsAwarded = 0;

    if (isCorrect) {
      const timeLimitMs = (currentQ.time_limit || 20) * 1000;
      // PS SkillSift speed formula: fast answer yields close to full points
      const speedFactor = Math.max(0.5, 1 - (timeTakenMs / (timeLimitMs * 2)));
      const basePoints = currentQ.points || 1000;
      pointsAwarded = Math.round(basePoints * speedFactor);

      // Streak multiplier bonus
      player.streak = (player.streak || 0) + 1;
      if (player.streak > 1) {
        pointsAwarded += Math.min(player.streak * 50, 500);
      }
      player.score = (player.score || 0) + pointsAwarded;
    } else {
      player.streak = 0;
    }

    if (chosenOption && chosenOption.color_index !== undefined) {
      const idx = chosenOption.color_index;
      if (idx >= 0 && idx < 4) {
        game.answerStats[idx] = (game.answerStats[idx] || 0) + 1;
      }
    }

    player.currentAnswer = {
      optionId,
      isCorrect,
      timeTakenMs,
      pointsAwarded
    };

    // Async record answer in DB without blocking the socket loop
    db.query(`
      INSERT INTO player_answers (session_id, player_id, question_id, option_id, is_correct, time_taken_ms, points_awarded)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [sessionId, playerId, currentQ.id, optionId, isCorrect, timeTakenMs, pointsAwarded]).catch(e => {
      console.error('Async DB answer save error:', e.message);
    });

    const answeredCount = this.getAnsweredCount(game);
    const totalPlayers = game.players.size;

    // Notify host with updated answer count
    this.io.to(`session:${sessionId}`).emit('answer-count-update', {
      answeredCount,
      totalPlayers
    });

    // Check if ALL players have answered -> auto finish
    if (answeredCount >= totalPlayers && totalPlayers > 0) {
      this.clearGameTimer(sessionId);
      this.finishQuestion(sessionId);
    }

    return {
      success: true,
      answered: true
    };
  }

  async finishQuestion(sessionId) {
    const game = this.games.get(sessionId);
    if (!game || game.state !== 'question') return;

    this.clearGameTimer(sessionId);
    game.state = 'result';

    const currentQ = game.questions[game.currentQIndex];
    const correctOptions = (currentQ.options || []).filter(o => o.is_correct);
    const correctOptionIds = correctOptions.map(o => o.id);

    // Compute updated ranks
    const sortedPlayers = Array.from(game.players.values()).sort((a, b) => b.score - a.score);
    sortedPlayers.forEach((p, idx) => {
      p.rank = idx + 1;
      // Persist score & streak in DB
      db.query(`UPDATE session_players SET score = $1, streak = $2, rank = $3 WHERE id = $4`,
        [p.score, p.streak, p.rank, p.id]
      ).catch(() => {});
    });

    // Broadcast result overview to Host
    this.io.to(`session:${sessionId}`).emit('question-result', {
      questionIndex: game.currentQIndex,
      correctOptionIds,
      correctOptions,
      answerStats: game.answerStats,
      questionText: currentQ.question_text,
      options: (currentQ.options || []).map((o, idx) => ({
        id: o.id,
        option_text: o.option_text,
        color_index: o.color_index !== undefined ? o.color_index : idx,
        is_correct: !!o.is_correct
      }))
    });

    // Send individualized results to each player socket
    game.players.forEach(p => {
      const sock = this.io.sockets.sockets.get(p.socketId);
      if (sock) {
        const ans = p.currentAnswer;
        sock.emit('player-question-result', {
          isCorrect: ans ? ans.isCorrect : false,
          pointsAwarded: ans ? ans.pointsAwarded : 0,
          totalScore: p.score,
          streak: p.streak,
          rank: p.rank,
          correctOptionIds,
          correctOptions: correctOptions.map(o => ({ id: o.id, option_text: o.option_text }))
        });
      }
    });
  }

  showLeaderboard(sessionId) {
    const game = this.games.get(sessionId);
    if (!game) return;

    game.state = 'leaderboard';

    const sorted = Array.from(game.players.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(p => ({
        id: p.id,
        nickname: p.nickname,
        score: p.score,
        streak: p.streak,
        rank: p.rank
      }));

    this.io.to(`session:${sessionId}`).emit('show-leaderboard', {
      leaderboard: sorted,
      isLastQuestion: game.currentQIndex >= game.questions.length - 1
    });
  }

  async showPodium(sessionId) {
    const game = this.games.get(sessionId);
    if (!game) return;

    this.clearGameTimer(sessionId);
    game.state = 'podium';

    const podium = Array.from(game.players.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((p, idx) => ({
        id: p.id,
        nickname: p.nickname,
        score: p.score,
        place: idx + 1
      }));

    this.io.to(`session:${sessionId}`).emit('game-podium', {
      podium,
      totalPlayers: game.players.size,
      quizTitle: game.quiz.title
    });

    // Mark session completed in DB
    try {
      await db.query(`UPDATE game_sessions SET status = 'finished', ended_at = NOW() WHERE id = $1`, [sessionId]);
    } catch (err) {
      console.error('Error finalizing session in DB:', err);
    }
  }

  async kickPlayer(sessionId, playerId) {
    const game = this.games.get(sessionId);
    if (!game) return { success: false, error: 'Game not found' };

    const player = game.players.get(playerId);
    if (!player) return { success: false, error: 'Player not found in active session' };

    console.log(`[GameManager] Host kicked player "${player.nickname}" (${playerId}) from session ${sessionId}`);

    // 1. Notify the kicked player's socket directly
    const sock = this.io.sockets.sockets.get(player.socketId);
    if (sock) {
      sock.emit('player-kicked', { message: 'You have been removed from this game by the host.' });
      sock.leave(`session:${sessionId}`);
    }

    // 2. Remove player from in-memory game state
    game.players.delete(playerId);

    // 3. Delete player from DB
    db.query(`DELETE FROM session_players WHERE id = $1`, [playerId]).catch(e => {
      console.error('Error deleting kicked player from db:', e.message);
    });

    // 4. Broadcast updated roster to host and lobby
    this.broadcastLobbyUpdate(sessionId);

    // 5. If mid-question, re-check answered count
    if (game.state === 'question') {
      const answeredCount = this.getAnsweredCount(game);
      const totalPlayers = game.players.size;
      this.io.to(`session:${sessionId}`).emit('answer-count-update', {
        answeredCount,
        totalPlayers
      });
      if (answeredCount >= totalPlayers && totalPlayers > 0) {
        this.clearGameTimer(sessionId);
        this.finishQuestion(sessionId);
      }
    }

    return { success: true, kickedPlayerId: playerId };
  }

  endGame(sessionId) {
    this.clearGameTimer(sessionId);
    const game = this.games.get(sessionId);
    if (game) {
      game.state = 'finished';
      this.io.to(`session:${sessionId}`).emit('game-ended');
      this.games.delete(sessionId);
    }
  }
}

const gameManager = new GameManager();
module.exports = gameManager;
