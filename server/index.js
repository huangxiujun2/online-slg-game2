import { createServer } from 'node:http'
import express from 'express'
import { Server } from 'socket.io'

const app = express()
const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: { origin: '*' },
})

const rooms = new Map()
const PORT = Number(process.env.PORT) || 3001
const UNIT_LIMIT = 30

function createRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code
  do {
    code = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('')
  } while (rooms.has(code))
  return code
}

function makeRoom(code, player) {
  return {
    code,
    status: 'waiting',
    winner: null,
    players: [{
      id: player.id,
      name: player.name,
      team: 0,
      connected: true,
      resources: { food: 180, wood: 120, gold: 100 },
      castleHp: 100,
    }],
    units: [],
    lastIncome: Date.now(),
    lastBroadcast: Date.now(),
  }
}

function addStartingUnits(room) {
  room.players.forEach((player) => {
    const side = player.team === 0 ? 1 : -1
    const baseX = player.team === 0 ? 12 : 88
    room.units.push({
      id: `${player.team}-worker`,
      owner: player.id,
      type: 'worker',
      x: baseX + side * 6,
      y: 50,
      target: null,
      hp: 40,
      lastAttack: 0,
    })
  })
}

function publicState(room) {
  return {
    code: room.code,
    status: room.status,
    winner: room.winner,
    players: room.players.map(({ id, name, team, connected, resources, castleHp }) => ({
      id, name, team, connected, resources, castleHp,
    })),
    units: room.units.map(({ id, owner, type, x, y, target, hp }) => ({
      id, owner, type, x, y, target, hp,
    })),
  }
}

function broadcastRoom(room) {
  io.to(room.code).emit('game-state', publicState(room))
}

function getPlayer(room, socketId) {
  return room.players.find((player) => player.id === socketId)
}

function validName(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 16
}

io.on('connection', (socket) => {
  socket.emit('identity', socket.id)

  socket.on('create-room', (name, callback) => {
    if (!validName(name)) return callback?.({ error: '名稱需為 1 到 16 個字元。' })
    const code = createRoomCode()
    const room = makeRoom(code, { id: socket.id, name: name.trim() })
    rooms.set(code, room)
    socket.join(code)
    callback?.({ code })
    broadcastRoom(room)
  })

  socket.on('join-room', ({ code, name } = {}, callback) => {
    if (!validName(name)) return callback?.({ error: '名稱需為 1 到 16 個字元。' })
    const normalizedCode = typeof code === 'string' ? code.trim().toUpperCase() : ''
    const room = rooms.get(normalizedCode)
    if (!room) return callback?.({ error: '找不到這個房間，請確認房間代碼。' })
    if (room.players.length >= 2 || room.status !== 'waiting') {
      return callback?.({ error: '這個房間已經開始或人數已滿。' })
    }

    room.players.push({
      id: socket.id,
      name: name.trim(),
      team: 1,
      connected: true,
      resources: { food: 180, wood: 120, gold: 100 },
      castleHp: 100,
    })
    socket.join(room.code)
    room.status = 'playing'
    addStartingUnits(room)
    callback?.({ code: room.code })
    broadcastRoom(room)
  })

  socket.on('train-unit', ({ code, type } = {}) => {
    const room = rooms.get(code)
    const player = room && getPlayer(room, socket.id)
    if (!player || room.status !== 'playing') return
    if (type !== 'worker' && type !== 'soldier') return
    if (room.units.length >= UNIT_LIMIT) {
      socket.emit('game-error', '部隊已達上限。')
      return
    }

    const cost = type === 'worker'
      ? { food: 50, gold: 0 }
      : { food: 70, gold: 30 }
    if (player.resources.food < cost.food || player.resources.gold < cost.gold) {
      socket.emit('game-error', '資源不足，無法訓練。')
      return
    }
    player.resources.food -= cost.food
    player.resources.gold -= cost.gold
    const baseX = player.team === 0 ? 12 : 88
    room.units.push({
      id: `${socket.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      owner: socket.id,
      type,
      x: baseX + (player.team === 0 ? 6 : -6),
      y: 50 + (Math.random() * 8 - 4),
      target: null,
      hp: type === 'worker' ? 40 : 70,
      lastAttack: 0,
    })
    broadcastRoom(room)
  })

  socket.on('move-units', ({ code, unitIds, x, y } = {}) => {
    const room = rooms.get(code)
    if (!room || room.status !== 'playing' || !getPlayer(room, socket.id)) return
    if (!Array.isArray(unitIds) || !Number.isFinite(x) || !Number.isFinite(y)) return
    const destination = { x: Math.max(3, Math.min(97, x)), y: Math.max(3, Math.min(97, y)) }
    const selectedIds = new Set(unitIds.slice(0, UNIT_LIMIT))
    room.units.forEach((unit) => {
      if (unit.owner === socket.id && selectedIds.has(unit.id)) unit.target = destination
    })
    broadcastRoom(room)
  })

  socket.on('disconnect', () => {
    for (const room of rooms.values()) {
      const player = getPlayer(room, socket.id)
      if (!player) continue
      player.connected = false
      broadcastRoom(room)
      break
    }
  })
})

setInterval(() => {
  const now = Date.now()
  for (const room of rooms.values()) {
    if (room.status !== 'playing') continue

    if (now - room.lastIncome >= 1000) {
      const seconds = Math.floor((now - room.lastIncome) / 1000)
      room.lastIncome += seconds * 1000
      room.players.forEach((player) => {
        const workers = room.units.filter((unit) => unit.owner === player.id && unit.type === 'worker').length
        player.resources.food += seconds * (1 + workers)
        player.resources.wood += seconds
        player.resources.gold += seconds
      })
    }

    for (const unit of room.units) {
      if (unit.type === 'soldier') {
        const enemy = room.players.find((player) => player.id !== unit.owner)
        if (enemy) {
          const castleX = enemy.team === 0 ? 12 : 88
          const distance = Math.hypot(unit.x - castleX, unit.y - 50)
          if (distance <= 7) {
            unit.target = null
            if (now - unit.lastAttack >= 900) {
              enemy.castleHp = Math.max(0, enemy.castleHp - 8)
              unit.lastAttack = now
            }
          }
        }
      }
      if (unit.target) {
        const dx = unit.target.x - unit.x
        const dy = unit.target.y - unit.y
        const length = Math.hypot(dx, dy)
        const step = Math.min(length, 0.9)
        if (length < 0.8) unit.target = null
        else {
          unit.x += (dx / length) * step
          unit.y += (dy / length) * step
        }
      }
    }

    if (room.players.some((player) => player.castleHp <= 0)) {
      room.status = 'finished'
      room.winner = room.players.find((player) => player.castleHp > 0)?.id ?? null
    }
    if (now - room.lastBroadcast >= 250) {
      room.lastBroadcast = now
      broadcastRoom(room)
    }
  }
}, 100)

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Game server listening on http://0.0.0.0:${PORT}`)
})
