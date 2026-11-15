<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const playerName = ref('')
const offerInput = ref('')
const answerInput = ref('')
const hostOfferCode = ref('')
const guestAnswerCode = ref('')
const room = ref(null)
const role = ref('')
const selectedIds = ref([])
const errorMessage = ref('')
const peerConnected = ref(false)
const mode = ref('lobby')
const busy = ref(false)
const mapSvg = ref(null)
const mapViewport = ref({ x: 90, y: 65, width: 820, height: 520 })
const mapViewBox = computed(() => {
  const { x, y, width, height } = mapViewport.value
  return `${x} ${y} ${width} ${height}`
})
const isMapDragging = ref(false)

let peerConnection
let dataChannel
let gameTimer
let resizeObserver
let mapDrag
let ignoreMapClick = false
let lastIncome = Date.now()
let lastBroadcast = Date.now()

const myId = computed(() => role.value === 'host' ? 'host' : 'guest')
const me = computed(() => room.value?.players.find((player) => player.id === myId.value))
const myUnits = computed(() => room.value?.units.filter((unit) => unit.owner === myId.value) ?? [])
const selectedUnits = computed(() => myUnits.value.filter((unit) => selectedIds.value.includes(unit.id)))
const isWaiting = computed(() => room.value?.status === 'waiting')
const isPlaying = computed(() => room.value?.status === 'playing')
const hasWon = computed(() => room.value?.winner === myId.value)
const connected = computed(() => peerConnected.value)

const trees = [
  [24, 21], [31, 28], [41, 18], [57, 25], [70, 18], [78, 32], [27, 73],
  [39, 81], [55, 74], [68, 84], [76, 70], [46, 37], [61, 58], [34, 57],
]

function playerFor(id, name, team) {
  return {
    id,
    name,
    team,
    connected: true,
    resources: { food: 180, wood: 120, gold: 100 },
    castleHp: 100,
  }
}

function makeStartingUnit(id, owner, type, x, y) {
  return { id, owner, type, x, y, target: null, hp: type === 'worker' ? 40 : 70, lastAttack: 0 }
}

function sendToPeer(message) {
  if (dataChannel?.readyState === 'open') dataChannel.send(JSON.stringify(message))
}

function publishState() {
  if (role.value === 'host') sendToPeer({ kind: 'state', state: JSON.parse(JSON.stringify(room.value)) })
}

function sendError(message) {
  errorMessage.value = message
  sendToPeer({ kind: 'error', message })
}

function startHostGame(opponentName) {
  if (room.value.status !== 'waiting') return
  room.value.players.push(playerFor('guest', opponentName, 1))
  room.value.units.push(
    makeStartingUnit('host-worker', 'host', 'worker', 18, 50),
    makeStartingUnit('guest-worker', 'guest', 'worker', 82, 50),
  )
  room.value.status = 'playing'
  mode.value = 'playing'
  lastIncome = Date.now()
  lastBroadcast = Date.now()
  publishState()
  gameTimer = window.setInterval(simulateGame, 100)
}

function handleHostMessage(message) {
  if (message.kind === 'join') {
    if (typeof message.name !== 'string' || !message.name.trim() || message.name.length > 16) {
      sendError('玩家名稱無效，請重新建立連線。')
      return
    }
    startHostGame(message.name.trim())
    return
  }
  if (message.kind === 'action' && message.action) {
    applyAction(message.action, 'guest')
    return
  }
  if (message.kind === 'state-request') publishState()
}

function handleChannelMessage(event) {
  let message
  try {
    message = JSON.parse(event.data)
  } catch {
    sendError('收到無法辨識的連線資料。')
    return
  }
  if (!message || typeof message !== 'object') return
  if (role.value === 'host') {
    handleHostMessage(message)
  } else if (message.kind === 'state' && message.state) {
    room.value = message.state
    mode.value = message.state.status === 'waiting' ? 'host-waiting' : 'playing'
    selectedIds.value = selectedIds.value.filter((id) => message.state.units.some((unit) => unit.id === id))
  } else if (message.kind === 'error' && typeof message.message === 'string') {
    errorMessage.value = message.message
  }
}

function attachDataChannel(channel) {
  dataChannel = channel
  channel.onopen = () => {
    peerConnected.value = true
    errorMessage.value = ''
    if (role.value === 'host') {
      mode.value = 'host-waiting'
    } else {
      sendToPeer({ kind: 'join', name: playerName.value.trim() })
    }
  }
  channel.onmessage = handleChannelMessage
  channel.onclose = () => {
    peerConnected.value = false
    if (room.value) {
      const opponent = room.value.players.find((player) => player.id !== myId.value)
      if (opponent) opponent.connected = false
    }
    errorMessage.value = '與房主的直接連線已中斷。'
  }
}

function makePeerConnection() {
  peerConnection = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  })
  peerConnection.onconnectionstatechange = () => {
    if (peerConnection.connectionState === 'failed') {
      errorMessage.value = '目前網路無法建立直接連線，請確認雙方網路後重試。'
    }
  }
  return peerConnection
}

function waitForIceGathering(peer) {
  if (peer.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout)
      peer.removeEventListener('icegatheringstatechange', handleChange)
    }
    const handleChange = () => {
      if (peer.iceGatheringState !== 'complete') return
      cleanup()
      resolve()
    }
    const timeout = window.setTimeout(() => {
      cleanup()
      reject(new Error('連線資訊準備逾時，請再試一次。'))
    }, 20000)
    peer.addEventListener('icegatheringstatechange', handleChange)
  })
}

function encodeDescription(description) {
  return btoa(JSON.stringify(description))
}

function decodeDescription(code, expectedType) {
  const description = JSON.parse(atob(code.trim()))
  if (description.type !== expectedType || typeof description.sdp !== 'string') {
    throw new Error('連線代碼格式不正確，請確認複製完整。')
  }
  return description
}

function validatePlayerName() {
  if (!playerName.value.trim() || playerName.value.trim().length > 16) {
    errorMessage.value = '名稱需為 1 到 16 個字元。'
    return false
  }
  return true
}

async function createRoom() {
  if (!validatePlayerName()) return
  errorMessage.value = ''
  busy.value = true
  role.value = 'host'
  room.value = {
    status: 'waiting',
    winner: null,
    players: [playerFor('host', playerName.value.trim(), 0)],
    units: [],
  }
  try {
    const peer = makePeerConnection()
    attachDataChannel(peer.createDataChannel('frontier-game'))
    const offer = await peer.createOffer()
    await peer.setLocalDescription(offer)
    await waitForIceGathering(peer)
    hostOfferCode.value = encodeDescription(peer.localDescription)
    mode.value = 'host-offer'
  } catch (error) {
    errorMessage.value = error.message || '無法建立連線邀請。'
    closeConnection()
    room.value = null
    role.value = ''
  } finally {
    busy.value = false
  }
}

async function joinRoom() {
  if (!validatePlayerName()) return
  errorMessage.value = ''
  if (!offerInput.value.trim()) {
    errorMessage.value = '請先貼上房主傳來的連線代碼。'
    return
  }
  busy.value = true
  role.value = 'guest'
  try {
    const peer = makePeerConnection()
    peer.ondatachannel = (event) => attachDataChannel(event.channel)
    await peer.setRemoteDescription(decodeDescription(offerInput.value, 'offer'))
    const answer = await peer.createAnswer()
    await peer.setLocalDescription(answer)
    await waitForIceGathering(peer)
    guestAnswerCode.value = encodeDescription(peer.localDescription)
    mode.value = 'guest-answer'
  } catch (error) {
    errorMessage.value = error.message || '無法建立回覆代碼。'
    closeConnection()
    role.value = ''
  } finally {
    busy.value = false
  }
}

async function acceptAnswer() {
  if (!answerInput.value.trim()) {
    errorMessage.value = '請貼上朋友回傳的連線代碼。'
    return
  }
  busy.value = true
  errorMessage.value = ''
  try {
    await peerConnection.setRemoteDescription(decodeDescription(answerInput.value, 'answer'))
    mode.value = 'host-waiting'
  } catch (error) {
    errorMessage.value = error.message || '無法使用這組連線代碼。'
  } finally {
    busy.value = false
  }
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value)
    errorMessage.value = ''
  } catch {
    errorMessage.value = '無法使用剪貼簿，請手動選取並複製代碼。'
  }
}

function applyAction(action, owner) {
  if (!room.value || room.value.status !== 'playing') return
  if (action.type === 'train') {
    const type = action.unitType
    if (type !== 'worker' && type !== 'soldier') return
    if (room.value.units.length >= 30) {
      if (owner === myId.value) errorMessage.value = '部隊已達上限。'
      else sendError('部隊已達上限。')
      return
    }
    const player = room.value.players.find((item) => item.id === owner)
    if (!player) return
    const cost = type === 'worker' ? { food: 50, gold: 0 } : { food: 70, gold: 30 }
    if (player.resources.food < cost.food || player.resources.gold < cost.gold) {
      if (owner === myId.value) errorMessage.value = '資源不足，無法訓練。'
      else sendError('資源不足，無法訓練。')
      return
    }
    player.resources.food -= cost.food
    player.resources.gold -= cost.gold
    const baseX = player.team === 0 ? 12 : 88
    room.value.units.push(makeStartingUnit(
      `${owner}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      owner,
      type,
      baseX + (player.team === 0 ? 6 : -6),
      50 + (Math.random() * 8 - 4),
    ))
  } else if (action.type === 'move') {
    if (!Array.isArray(action.unitIds) || !Number.isFinite(action.x) || !Number.isFinite(action.y)) return
    const selected = new Set(action.unitIds.slice(0, 30))
    room.value.units.forEach((unit) => {
      if (unit.owner === owner && selected.has(unit.id)) {
        unit.target = {
          x: Math.max(3, Math.min(97, action.x)),
          y: Math.max(3, Math.min(97, action.y)),
        }
      }
    })
  } else {
    return
  }
  publishState()
}

function train(type) {
  if (!room.value) return
  const action = { type: 'train', unitType: type }
  if (role.value === 'host') applyAction(action, 'host')
  else sendToPeer({ kind: 'action', action })
}

function toggleUnit(unit) {
  if (selectedIds.value.includes(unit.id)) {
    selectedIds.value = selectedIds.value.filter((id) => id !== unit.id)
  } else {
    selectedIds.value = [...selectedIds.value, unit.id]
  }
}

function pointFor(unit) {
  return {
    x: 500 + (unit.x - unit.y) * 4.5,
    y: 115 + (unit.x + unit.y) * 2.1,
  }
}

function handleMapClick(event) {
  if (ignoreMapClick) {
    ignoreMapClick = false
    return
  }
  if (!room.value || selectedIds.value.length === 0) return
  const bounds = event.currentTarget.getBoundingClientRect()
  const sx = mapViewport.value.x + ((event.clientX - bounds.left) / bounds.width) * mapViewport.value.width
  const sy = mapViewport.value.y + ((event.clientY - bounds.top) / bounds.height) * mapViewport.value.height
  const dx = (sx - 500) / 4.5
  const dy = (sy - 115) / 2.1
  const x = (dx + dy) / 2
  const y = (dy - dx) / 2
  if (x < 0 || x > 100 || y < 0 || y > 100) return
  const action = { type: 'move', unitIds: selectedIds.value, x, y }
  if (role.value === 'host') applyAction(action, 'host')
  else sendToPeer({ kind: 'action', action })
  selectedIds.value = []
}

function selectAll() {
  selectedIds.value = myUnits.value.map((unit) => unit.id)
}

function handleKeydown(event) {
  if (event.key === 'Escape') selectedIds.value = []
  if (event.key.toLowerCase() === 'a' && isPlaying.value) selectAll()
}

function displayResource(value) {
  return Math.floor(value ?? 0)
}

function updateMapViewport() {
  const bounds = mapSvg.value?.getBoundingClientRect()
  if (!bounds?.width || !bounds.height) return
  const previous = mapViewport.value
  let width = 880
  let height = width * bounds.height / bounds.width
  if (height > 590) {
    height = 590
    width = height * bounds.width / bounds.height
  }
  const centerX = previous.x + previous.width / 2
  const centerY = previous.y + previous.height / 2
  mapViewport.value = {
    width,
    height,
    x: Math.max(0, Math.min(1000 - width, centerX - width / 2)),
    y: Math.max(0, Math.min(650 - height, centerY - height / 2)),
  }
}

function startMapDrag(event) {
  if (event.button !== 0) return
  mapDrag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    viewX: mapViewport.value.x,
    viewY: mapViewport.value.y,
    moved: false,
  }
  event.currentTarget.setPointerCapture(event.pointerId)
}

function moveMap(event) {
  if (!mapDrag || event.pointerId !== mapDrag.pointerId) return
  const bounds = mapSvg.value.getBoundingClientRect()
  const deltaX = event.clientX - mapDrag.startX
  const deltaY = event.clientY - mapDrag.startY
  if (!mapDrag.moved && Math.hypot(deltaX, deltaY) < 4) return
  mapDrag.moved = true
  isMapDragging.value = true
  mapViewport.value = {
    ...mapViewport.value,
    x: Math.max(0, Math.min(1000 - mapViewport.value.width, mapDrag.viewX - deltaX * mapViewport.value.width / bounds.width)),
    y: Math.max(0, Math.min(650 - mapViewport.value.height, mapDrag.viewY - deltaY * mapViewport.value.height / bounds.height)),
  }
}

function endMapDrag() {
  if (mapDrag?.moved) {
    window.setTimeout(() => { isMapDragging.value = false }, 0)
    ignoreMapClick = true
    window.setTimeout(() => { ignoreMapClick = false }, 250)
  }
  mapDrag = null
}

function cancelMapDrag() {
  mapDrag = null
  isMapDragging.value = false
}

function centerMapFromMiniMap(event) {
  const bounds = event.currentTarget.getBoundingClientRect()
  const x = ((event.clientX - bounds.left) / bounds.width) * 1000
  const y = ((event.clientY - bounds.top) / bounds.height) * 650
  mapViewport.value = {
    ...mapViewport.value,
    x: Math.max(0, Math.min(1000 - mapViewport.value.width, x - mapViewport.value.width / 2)),
    y: Math.max(0, Math.min(650 - mapViewport.value.height, y - mapViewport.value.height / 2)),
  }
}

function simulateGame() {
  if (role.value !== 'host' || room.value?.status !== 'playing') return
  const now = Date.now()
  if (now - lastIncome >= 1000) {
    const seconds = Math.floor((now - lastIncome) / 1000)
    lastIncome += seconds * 1000
    room.value.players.forEach((player) => {
      const workers = room.value.units.filter((unit) => unit.owner === player.id && unit.type === 'worker').length
      player.resources.food += seconds * (1 + workers)
      player.resources.wood += seconds
      player.resources.gold += seconds
    })
  }
  for (const unit of room.value.units) {
    if (unit.type === 'soldier') {
      const enemy = room.value.players.find((player) => player.id !== unit.owner)
      if (enemy) {
        const castleX = enemy.team === 0 ? 12 : 88
        if (Math.hypot(unit.x - castleX, unit.y - 50) <= 7) {
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
  if (room.value.players.some((player) => player.castleHp <= 0)) {
    room.value.status = 'finished'
    room.value.winner = room.value.players.find((player) => player.castleHp > 0)?.id ?? null
    window.clearInterval(gameTimer)
    gameTimer = null
  }
  if (now - lastBroadcast >= 250) {
    lastBroadcast = now
    publishState()
  }
}

function getPlayerForUnit(unit) {
  return room.value?.players.find((player) => player.id === unit.owner)
}

function closeConnection() {
  window.clearInterval(gameTimer)
  gameTimer = null
  dataChannel?.close()
  peerConnection?.close()
  dataChannel = undefined
  peerConnection = undefined
  peerConnected.value = false
}

function resetToLobby() {
  closeConnection()
  role.value = ''
  room.value = null
  mode.value = 'lobby'
  guestAnswerCode.value = ''
  offerInput.value = ''
  errorMessage.value = ''
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
})

watch(room, async (currentRoom) => {
  resizeObserver?.disconnect()
  resizeObserver = undefined
  if (!currentRoom) return
  await nextTick()
  updateMapViewport()
  if (mapSvg.value && 'ResizeObserver' in window) {
    resizeObserver = new ResizeObserver(updateMapViewport)
    resizeObserver.observe(mapSvg.value)
  }
}, { flush: 'post' })

onBeforeUnmount(() => {
  closeConnection()
  resizeObserver?.disconnect()
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <main class="app-shell" :class="{ 'is-game': room }">
    <header class="topbar">
      <a class="brand" href="#" aria-label="邊境紀元首頁">
        <span class="brand-mark">✳</span>
        <span>邊境<span class="brand-light">紀元</span></span>
      </a>
      <div class="topbar-meta">
        <span class="season-label">即時策略 · 多人對戰</span>
        <span class="connection"><i :class="{ online: connected }"></i>{{ connected ? '玩家直接連線中' : role === 'guest' ? '正在準備加入' : '瀏覽器房主模式' }}</span>
      </div>
    </header>

    <section v-if="!room" class="lobby">
      <div class="lobby-art" aria-hidden="true">
        <div class="sun-glow"></div>
        <div class="mountain mountain-back"></div>
        <div class="mountain mountain-front"></div>
        <div class="castle-silhouette"><span></span><i></i><b></b></div>
        <div class="art-caption"><span>THE FRONTIER AWAITS</span><span>一場新的征途，即將展開</span></div>
      </div>
      <div class="lobby-panel">
        <template v-if="mode === 'lobby'">
          <div class="eyebrow"><span></span> 建立你的傳奇</div>
          <h1>疆界之外，<br /><em>勝者為王。</em></h1>
          <p class="lobby-intro">召集你的部隊，發展城鎮，與朋友展開一場即時策略對決。</p>

          <label class="field-label" for="player-name">你的名字</label>
          <input id="player-name" v-model="playerName" maxlength="16" placeholder="輸入你的名字" autocomplete="nickname" />

          <button class="primary-button" :disabled="busy" @click="createRoom">
            <span>{{ busy ? '正在準備連線…' : '建立新戰局' }}</span><span class="button-arrow">↗</span>
          </button>
          <div class="divider"><span>或加入朋友的戰局</span></div>
          <label class="field-label" for="offer-code">貼上房主傳來的連線代碼</label>
          <textarea id="offer-code" v-model="offerInput" class="connection-code-input" rows="3" placeholder="貼上房主提供的連線代碼"></textarea>
          <button class="join-button join-wide" :disabled="busy" @click="joinRoom">{{ busy ? '正在建立回覆…' : '加入朋友的戰局' }}</button>
          <p class="lobby-foot"><span>⚔</span> 兩位玩家直接連線 · 房主需保持瀏覽器開啟</p>
        </template>
        <div v-else class="guest-answer">
          <div class="eyebrow"><span></span> 回覆房主邀請</div>
          <h1>再一步，<br /><em>加入戰場。</em></h1>
          <p class="lobby-intro">複製下方回覆代碼傳回房主；房主確認後就會進入戰局。</p>
          <label class="field-label" for="answer-code">你的連線回覆代碼</label>
          <textarea id="answer-code" :value="guestAnswerCode" class="connection-code-input" rows="6" readonly></textarea>
          <button class="primary-button" @click="copyText(guestAnswerCode)"><span>複製回覆代碼</span><span class="button-arrow">⧉</span></button>
          <button class="back-button" @click="resetToLobby">返回首頁</button>
        </div>
        <p v-if="errorMessage" class="error-message" role="alert">{{ errorMessage }}</p>
      </div>
    </section>

    <section v-else class="game-layout">
      <div class="game-heading">
        <div class="game-heading-title">
          <div class="eyebrow"><span></span> {{ isWaiting ? '等待對手加入' : room.status === 'finished' ? '戰局結束' : '戰役進行中' }}</div>
          <strong>{{ isWaiting ? '你的戰場已準備就緒' : room.status === 'finished' ? (hasWon ? '旗開得勝' : '下次再戰') : '為你的王國而戰' }}</strong>
        </div>
        <div class="resource-ribbon">
          <div class="hud-resource"><span class="resource-icon food-icon">✿</span><span>食物</span><strong>{{ displayResource(me?.resources.food) }}</strong><small>+{{ 1 + myUnits.filter((unit) => unit.type === 'worker').length }}/秒</small></div>
          <div class="hud-resource"><span class="resource-icon wood-icon">♧</span><span>木材</span><strong>{{ displayResource(me?.resources.wood) }}</strong><small>+1/秒</small></div>
          <div class="hud-resource"><span class="resource-icon gold-icon">◈</span><span>黃金</span><strong>{{ displayResource(me?.resources.gold) }}</strong><small>+1/秒</small></div>
        </div>
      </div>

      <div class="game-content">
        <aside class="side-panel">
          <div class="panel-heading"><span>⚑</span> 指揮中心 <span class="live-dot"></span></div>
          <div class="players-heading">戰場領主</div>
          <div v-for="player in room.players" :key="player.id" class="player-card" :class="{ 'is-me': player.id === myId }">
            <div class="player-top">
              <span class="team-emblem" :class="`team-${player.team}`">{{ player.team === 0 ? '✦' : '⚔' }}</span>
              <div class="player-info"><strong>{{ player.name }}<small v-if="player.id === myId">你</small></strong><span>{{ player.team === 0 ? '赤焰王國' : '蒼狼聯盟' }}</span></div>
              <span class="online-dot" :class="{ offline: !player.connected }"></span>
            </div>
            <div class="castle-health"><div><span>城堡耐久</span><span>{{ player.castleHp }}%</span></div><i><b :class="`health-${player.team}`" :style="{ width: `${player.castleHp}%` }"></b></i></div>
          </div>

          <div class="army-section">
            <div class="panel-subheading">你的軍隊 <span>{{ myUnits.length }} / 30</span></div>
            <div class="army-counts"><div><span class="mini-unit worker-mini">♟</span><span>村民</span><b>{{ myUnits.filter((unit) => unit.type === 'worker').length }}</b></div><div><span class="mini-unit soldier-mini">⚔</span><span>劍士</span><b>{{ myUnits.filter((unit) => unit.type === 'soldier').length }}</b></div></div>
          </div>

          <div class="train-section">
            <div class="panel-subheading">訓練部隊</div>
            <button class="train-button" :disabled="!isPlaying || myUnits.length >= 30 || me?.resources.food < 50" @click="train('worker')">
              <span class="train-icon worker-mini">♟</span><span class="train-copy"><strong>訓練村民</strong><small>建設你的經濟</small></span><span class="train-cost">✿ 50</span>
            </button>
            <button class="train-button" :disabled="!isPlaying || myUnits.length >= 30 || me?.resources.food < 70 || me?.resources.gold < 30" @click="train('soldier')">
              <span class="train-icon soldier-mini">⚔</span><span class="train-copy"><strong>訓練劍士</strong><small>攻擊敵方城堡</small></span><span class="train-cost">✿ 70<br />◈ 30</span>
            </button>
          </div>
          <div class="income-note">每位村民每秒生產 1 食物<br />城鎮每秒生產 1 木材與黃金</div>
        </aside>

        <div class="battle-column">
          <div class="battle-toolbar">
            <span><i></i> {{ isPlaying ? '戰場即時同步' : isWaiting ? '等待另一位玩家加入…' : '戰鬥已結束' }}</span>
            <button :disabled="myUnits.length === 0 || !isPlaying" @click="selectAll">選取全部 <kbd>A</kbd></button>
          </div>
          <div class="map-frame">
            <svg ref="mapSvg" class="battle-map" :class="{ dragging: isMapDragging }" :viewBox="mapViewBox" preserveAspectRatio="xMidYMid meet" role="application" aria-label="戰場地圖，拖曳移動視野，選取部隊後點擊地面移動" @pointerdown="startMapDrag" @pointermove="moveMap" @pointerup="endMapDrag" @pointercancel="cancelMapDrag" @click="handleMapClick">
              <defs>
                <linearGradient id="ground" x1="0" y1="0" x2="0.9" y2="1"><stop offset="0" stop-color="#637b50" /><stop offset="1" stop-color="#3d5b3e" /></linearGradient>
                <linearGradient id="castleRed" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d27a55" /><stop offset="1" stop-color="#773e37" /></linearGradient>
                <linearGradient id="castleBlue" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#79a2aa" /><stop offset="1" stop-color="#405b69" /></linearGradient>
                <filter id="shadow"><feDropShadow dx="0" dy="5" stdDeviation="4" flood-opacity=".28" /></filter>
              </defs>
              <rect width="1000" height="650" fill="#19251e" />
              <polygon points="500,115 950,325 500,535 50,325" fill="url(#ground)" stroke="#8a9364" stroke-width="2" />
              <polygon points="500,132 915,325 500,518 85,325" fill="none" stroke="#d3c58a" stroke-opacity=".15" stroke-width="1" />
              <path d="M170 333 Q300 278 415 316 T645 316 Q745 302 824 320" fill="none" stroke="#a99b6d" stroke-width="22" stroke-opacity=".38" />
              <path d="M170 333 Q300 278 415 316 T645 316 Q745 302 824 320" fill="none" stroke="#c3b783" stroke-width="2" stroke-dasharray="3 13" stroke-opacity=".34" />
              <g v-for="([x, y], index) in trees" :key="`tree-${index}`" class="map-decoration" :transform="`translate(${pointFor({ x, y }).x} ${pointFor({ x, y }).y})`">
                <ellipse cy="8" rx="13" ry="5" fill="#263c2d" opacity=".38" /><path d="M0 -7v17" stroke="#72593a" stroke-width="4" /><circle cy="-12" r="13" fill="#304e35" /><circle cx="-7" cy="-7" r="8" fill="#476845" /><circle cx="7" cy="-6" r="8" fill="#3c603f" />
              </g>
              <g class="castle" :transform="`translate(${pointFor({ x: 12, y: 50 }).x} ${pointFor({ x: 12, y: 50 }).y})`" filter="url(#shadow)">
                <ellipse cy="15" rx="39" ry="14" fill="#23382b" opacity=".5" /><path d="M-26 4h52v-28h-52z" fill="url(#castleRed)" stroke="#edb278" stroke-width="1.5" /><path d="M-33 -23h15v-22h-15zM-8 -23h16v-29H-8zM18 -23h15v-22H18z" fill="#9d5944" stroke="#edb278" stroke-width="1.5" /><path d="M-31 -45h11l-5.5 -8zM-6 -52h12l-6 -9zM20 -45h11l-5.5 -8z" fill="#c47b58" /><path d="M-5 4v-18q5-10 10 0V4" fill="#493b30" /><path d="M0 -54v-16" stroke="#e9c78e" stroke-width="2" /><path d="M1 -69h16l-16 9z" fill="#d89462" /><text y="26" text-anchor="middle" fill="#ffe1b3" font-size="12" font-weight="700">赤焰城堡</text>
              </g>
              <g class="castle" :transform="`translate(${pointFor({ x: 88, y: 50 }).x} ${pointFor({ x: 88, y: 50 }).y})`" filter="url(#shadow)">
                <ellipse cy="15" rx="39" ry="14" fill="#23382b" opacity=".5" /><path d="M-26 4h52v-28h-52z" fill="url(#castleBlue)" stroke="#b8d5d4" stroke-width="1.5" /><path d="M-33 -23h15v-22h-15zM-8 -23h16v-29H-8zM18 -23h15v-22H18z" fill="#527583" stroke="#b8d5d4" stroke-width="1.5" /><path d="M-31 -45h11l-5.5 -8zM-6 -52h12l-6 -9zM20 -45h11l-5.5 -8z" fill="#82a8aa" /><path d="M-5 4v-18q5-10 10 0V4" fill="#374849" /><path d="M0 -54v-16" stroke="#c7e0d9" stroke-width="2" /><path d="M1 -69h16l-16 9z" fill="#8eb8b6" /><text y="26" text-anchor="middle" fill="#d5efea" font-size="12" font-weight="700">蒼狼城堡</text>
              </g>
              <g v-for="unit in room.units" :key="unit.id" class="map-unit" :class="{ selected: selectedIds.includes(unit.id), 'enemy-unit': unit.owner !== myId }" :transform="`translate(${pointFor(unit).x} ${pointFor(unit).y})`" @pointerdown.stop @click.stop="unit.owner === myId && toggleUnit(unit)">
                <ellipse cy="5" rx="11" ry="5" fill="#213027" opacity=".55" />
                <circle v-if="selectedIds.includes(unit.id)" cy="1" r="15" fill="none" stroke="#f3d37e" stroke-width="2" stroke-dasharray="3 3" />
                <circle cy="-5" r="9" :fill="getPlayerForUnit(unit)?.team === 0 ? (unit.type === 'worker' ? '#e5b075' : '#c16d56') : (unit.type === 'worker' ? '#a9c5bd' : '#6996a0')" stroke="#f3dfb2" stroke-width="1.5" />
                <path :d="unit.type === 'worker' ? 'M0 -9l-3 -8 6 0zM-4 -1v-5q4-4 8 0v5' : 'M0 -7l4 -6 -1 8 5 -1 -7 8 -1 -6 -4 1z'" fill="#fff1cd" stroke="#5d4834" stroke-width=".8" />
                <rect x="-10" y="-23" width="20" height="3" rx="1.5" fill="#26342b" /><rect x="-10" y="-23" :width="20 * (unit.hp / (unit.type === 'worker' ? 40 : 70))" height="3" rx="1.5" fill="#a3c77a" />
                <text y="18" text-anchor="middle" fill="#f3e7c8" font-size="9" font-weight="600">{{ unit.type === 'worker' ? '村民' : '劍士' }}</text>
              </g>
              <g v-if="room.units.length === 0" transform="translate(500 320)" pointer-events="none"><text text-anchor="middle" fill="#eee2be" font-size="17">等待戰局開始…</text><text y="25" text-anchor="middle" fill="#d8cca9" font-size="12">朋友加入後，村民就會抵達戰場</text></g>
            </svg>
            <div class="minimap-panel">
              <div class="minimap-heading"><span>戰場地圖</span><span>N ↑</span></div>
              <svg class="minimap" viewBox="0 0 1000 650" aria-label="小地圖，點擊移動主視野" @click.stop="centerMapFromMiniMap">
                <rect width="1000" height="650" fill="#213326" />
                <polygon points="500,115 950,325 500,535 50,325" fill="#526b47" stroke="#a9a071" stroke-width="8" />
                <path d="M170 333 Q300 278 415 316 T645 316 Q745 302 824 320" fill="none" stroke="#b09b68" stroke-width="20" />
                <circle cx="329" cy="245" r="20" fill="#bd7757" stroke="#f0c48d" stroke-width="7" />
                <circle cx="671" cy="405" r="20" fill="#668e95" stroke="#b6d2cc" stroke-width="7" />
                <circle v-for="unit in room.units" :key="`mini-${unit.id}`" :cx="pointFor(unit).x" :cy="pointFor(unit).y" r="9" :fill="unit.owner === myId ? '#f0d07f' : '#dc8f78'" stroke="#1b261d" stroke-width="4" />
                <rect :x="mapViewport.x" :y="mapViewport.y" :width="mapViewport.width" :height="mapViewport.height" fill="#e8d39a" fill-opacity=".08" stroke="#f0d18a" stroke-width="8" />
              </svg>
              <div class="minimap-hint">點擊小地圖移動視野</div>
            </div>
            <div v-if="isWaiting" class="waiting-overlay">
              <div class="waiting-card connection-waiting-card">
                <template v-if="role === 'host' && mode === 'host-offer'">
                  <strong>把房主連線代碼傳給朋友</strong>
                  <p>朋友貼上代碼後，會回傳一組回覆代碼給你。</p>
                  <textarea v-model="hostOfferCode" class="connection-code-input" rows="4" readonly aria-label="房主連線代碼"></textarea>
                  <button class="join-button join-wide" @click="copyText(hostOfferCode)">複製房主連線代碼</button>
                  <label class="field-label answer-label" for="host-answer">貼上朋友回傳的連線代碼</label>
                  <textarea id="host-answer" v-model="answerInput" class="connection-code-input" rows="3" placeholder="朋友回傳的連線代碼"></textarea>
                  <button class="primary-button connect-button" :disabled="busy" @click="acceptAnswer">{{ busy ? '正在連線…' : '確認並連線' }}</button>
                </template>
                <template v-else>
                  <span class="waiting-spinner"></span>
                  <strong>{{ peerConnected ? '等待朋友完成加入' : '等待另一位領主加入' }}</strong>
                  <p>{{ peerConnected ? '點對點連線已建立，正在同步戰局。' : '房主已分享連線代碼後，朋友即可加入。' }}</p>
                  <textarea v-if="role === 'host'" v-model="hostOfferCode" class="connection-code-input" rows="3" readonly aria-label="房主連線代碼"></textarea>
                </template>
              </div>
            </div>
            <div v-if="room.status === 'finished'" class="finished-overlay"><div class="finished-card"><span>{{ hasWon ? '✦ 勝利' : '⚔ 戰敗' }}</span><strong>{{ hasWon ? '你的城堡屹立不搖。' : '你的城堡已經陷落。' }}</strong><p>重新整理頁面即可開啟新的戰局</p></div></div>
            <div class="map-compass">N <span>✦</span></div>
          </div>
          <div class="battle-footer"><span>{{ selectedUnits.length ? `已選取 ${selectedUnits.length} 支部隊` : '選取村民或劍士，再點擊地圖下達移動命令' }}</span><span>村民自動生產資源 · 劍士會自動攻擊敵方城堡</span></div>
          <p v-if="errorMessage" class="error-message game-error" role="alert">{{ errorMessage }}</p>
        </div>
      </div>
    </section>
    <footer class="site-footer"><span>邊境紀元 <i>·</i> 一起征服未知</span><span>策略由你決定，傳奇由你書寫</span></footer>
  </main>
</template>
