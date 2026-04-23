const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Serve the client from the repo root (so `index.html` works whether you deploy
// just the server, or host the client separately).
app.use(express.static(__dirname));

const CARD_LABELS = ['8', '9', '10', 'J', 'Q', 'K', 'A'];
const CARD_RANKS  = { '8':1, '9':2, '10':3, 'J':4, 'Q':5, 'K':6, 'A':7 };
const CARD_COLORS = { '8':'red', '9':'black', '10':'red', 'J':'black', 'Q':'red', 'K':'black', 'A':'red' };

const rooms = new Map();

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function freshHand() {
  return CARD_LABELS.map(label => ({ label, color: CARD_COLORS[label], played: false }));
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function buildStateForPlayer(room, playerIndex) {
  const g = room.game;
  const state = {
    type: 'state',
    phase: g.phase,
    round: g.round,
    scores: [...g.scores],
    myIndex: playerIndex,
    firstPlayer: g.firstPlayer,
    names: [...g.names],
    myHand: g.hands[playerIndex].map(c => ({ ...c })),
    announcedColor: g.announcedColor,
    reveal: null,
    myReady: g.nextRoundReady[playerIndex],
  };

  if (g.phase === 'reveal' || g.phase === 'game_over') {
    state.reveal = {
      myCard: (g.lastPlayed && g.lastPlayed[playerIndex]) || g.selectedCards[playerIndex],
      winner: g.winner,
    };
  }

  return state;
}

function broadcastState(room) {
  room.players.forEach((ws, idx) => {
    if (ws) send(ws, buildStateForPlayer(room, idx));
  });
}

function resolveRound(game) {
  const fp = game.firstPlayer;
  const sp = 1 - fp;
  const rankFirst  = CARD_RANKS[game.selectedCards[fp]];
  const rankSecond = CARD_RANKS[game.selectedCards[sp]];

  if (rankFirst > rankSecond) {
    game.winner = fp;
    game.scores[fp]++;
  } else if (rankSecond > rankFirst) {
    game.winner = sp;
    game.scores[sp]++;
  } else {
    game.winner = -1;
  }

  [0, 1].forEach(i => {
    const card = game.hands[i].find(c => c.label === game.selectedCards[i]);
    if (card) card.played = true;
  });

  game.lastPlayed = [...game.selectedCards];
  game.phase = 'reveal';
}

wss.on('connection', ws => {
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const room = rooms.get(ws.roomCode);

    if (msg.type === 'create') {
      const name = (msg.name || '').toString().trim().slice(0, 18) || 'Player 1';
      const code = generateCode();
      const newRoom = {
        code,
        players: [ws, null],
        game: {
          phase: 'waiting',
          round: 1,
          scores: [0, 0],
          hands: [freshHand(), freshHand()],
          firstPlayer: 0,
          names: [name, null],
          selectedCards: [null, null],
          announcedColor: null,
          winner: undefined,
          nextRoundReady: [false, false],
        },
      };
      rooms.set(code, newRoom);
      ws.roomCode = code;
      ws.playerIndex = 0;
      ws.playerName = name;
      send(ws, { type: 'joined', playerIndex: 0, code });
      broadcastState(newRoom);
      return;
    }

    if (msg.type === 'join') {
      const code = (msg.code || '').toUpperCase().trim();
      const targetRoom = rooms.get(code);
      if (!targetRoom) {
        send(ws, { type: 'error', message: 'Room not found. Check the code and try again.' });
        return;
      }
      if (targetRoom.players[1]) {
        send(ws, { type: 'error', message: 'This room is already full.' });
        return;
      }
      targetRoom.players[1] = ws;
      ws.roomCode = code;
      ws.playerIndex = 1;
      const name = (msg.name || '').toString().trim().slice(0, 18) || 'Player 2';
      ws.playerName = name;
      targetRoom.game.names[1] = name;
      targetRoom.game.phase = 'pick1';
      send(ws, { type: 'joined', playerIndex: 1, code });
      broadcastState(targetRoom);
      return;
    }

    if (!room) return;
    const game = room.game;

    if (msg.type === 'pick') {
      const label = msg.label;
      if (!CARD_LABELS.includes(label)) return;
      const pi = ws.playerIndex;

      if (game.phase === 'pick1' && pi === game.firstPlayer) {
        const card = game.hands[pi].find(c => c.label === label && !c.played);
        if (!card) return;
        game.selectedCards[game.firstPlayer] = label;
        game.announcedColor = CARD_COLORS[label];
        game.phase = 'pick2';
        broadcastState(room);
        return;
      }

      if (game.phase === 'pick2' && pi !== game.firstPlayer) {
        const card = game.hands[pi].find(c => c.label === label && !c.played);
        if (!card) return;
        game.selectedCards[1 - game.firstPlayer] = label;
        resolveRound(game);
        broadcastState(room);
        return;
      }
    }

    if (msg.type === 'next') {
      if (game.phase !== 'reveal') return;
      game.nextRoundReady[ws.playerIndex] = true;

      if (game.nextRoundReady[0] && game.nextRoundReady[1]) {
        game.round++;
        if (game.round > 7) {
          game.phase = 'game_over';
        } else {
          game.firstPlayer = 1 - game.firstPlayer;
          game.selectedCards = [null, null];
          game.announcedColor = null;
          game.winner = undefined;
          game.nextRoundReady = [false, false];
          game.phase = 'pick1';
        }
      }
      broadcastState(room);
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    room.players.forEach(p => {
      if (p && p !== ws) send(p, { type: 'opponent_disconnected' });
    });
    rooms.delete(ws.roomCode);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Red & Black running at http://localhost:${PORT}`);
});
