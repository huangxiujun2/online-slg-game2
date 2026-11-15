<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { io } from 'socket.io-client'

const socket = io()
const playerName = ref('')
const roomCodeInput = ref('')
const room = ref(null)
const myId = ref('')
const selectedIds = ref([])
const errorMessage = ref('')
const connected = ref(false)

const me = computed(() => room.value?.players.find((player) => player.id === myId.value))
const opponent = computed(() => room.value?.players.find((player) => player.id !== myId.value))
const myUnits = computed(() => room.value?.units.filter((unit) => unit.owner === myId.value) ?? [])
const selectedUnits = computed(() => myUnits.value.filter((unit) => selectedIds.value.includes(unit.id)))
const isWaiting = computed(() => room.value?.status === 'waiting')
const isPlaying = computed(() => room.value?.status === 'playing')
const hasWon = computed(() => room.value?.winner === myId.value)

const trees = [
  [24, 21], [31, 28], [41, 18], [57, 25], [70, 18], [78, 32], [27, 73],
  [39, 81], [55, 74], [68, 84], [76, 70], [46, 37], [61, 58], [34, 57],
]

function respondWithError(error) {
  errorMessage.value = error?.message ?? '無法連線到遊戲伺服器。'
}

function createRoom() {
  errorMessage.value = ''
  socket.emit('create-room', playerName.value, (result) => {
    if (result?.error) errorMessage.value = result.error
    else roomCodeInput.value = result.code
  })
}

function joinRoom() {
  errorMessage.value = ''
  socket.emit('join-room', { code: roomCodeInput.value, name: playerName.value }, (result) => {
    if (result?.error) errorMessage.value = result.error
  })
}

function train(type) {
  if (!room.value) return
  socket.emit('train-unit', { code: room.value.code, type })
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
  if (!room.value || selectedIds.value.length === 0) return
  const bounds = event.currentTarget.getBoundingClientRect()
  const sx = ((event.clientX - bounds.left) / bounds.width) * 1000
  const sy = ((event.clientY - bounds.top) / bounds.height) * 650
  const dx = (sx - 500) / 4.5
  const dy = (sy - 115) / 2.1
  const x = (dx + dy) / 2
  const y = (dy - dx) / 2
  if (x < 0 || x > 100 || y < 0 || y > 100) return
  socket.emit('move-units', { code: room.value.code, unitIds: selectedIds.value, x, y })
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

async function copyRoomCode() {
  try {
    await navigator.clipboard.writeText(room.value.code)
  } catch {
    errorMessage.value = '無法複製房間代碼，請手動分享代碼。'
  }
}

function getPlayerForUnit(unit) {
  return room.value?.players.find((player) => player.id === unit.owner)
}

onMounted(() => {
  socket.on('connect', () => {
    connected.value = true
    errorMessage.value = ''
  })
  socket.on('disconnect', () => {
    connected.value = false
    errorMessage.value = '與伺服器的連線中斷，請重新整理頁面。'
  })
  socket.on('connect_error', respondWithError)
  socket.on('identity', (id) => { myId.value = id })
  socket.on('game-state', (state) => {
    room.value = state
    selectedIds.value = selectedIds.value.filter((id) => state.units.some((unit) => unit.id === id))
  })
  socket.on('game-error', (message) => { errorMessage.value = message })
  window.addEventListener('keydown', handleKeydown)
})

onBeforeUnmount(() => {
  socket.disconnect()
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <main class="app-shell">
    <header class="topbar">
      <a class="brand" href="#" aria-label="邊境紀元首頁">
        <span class="brand-mark">✳</span>
        <span>邊境<span class="brand-light">紀元</span></span>
      </a>
      <div class="topbar-meta">
        <span class="season-label">即時策略 · 多人對戰</span>
        <span class="connection"><i :class="{ online: connected }"></i>{{ connected ? '伺服器連線正常' : '連線中…' }}</span>
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
        <div class="eyebrow"><span></span> 建立你的傳奇</div>
        <h1>疆界之外，<br /><em>勝者為王。</em></h1>
        <p class="lobby-intro">召集你的部隊，發展城鎮，與朋友展開一場即時策略對決。</p>

        <label class="field-label" for="player-name">你的名字</label>
        <input id="player-name" v-model="playerName" maxlength="16" placeholder="輸入你的名字" autocomplete="nickname" />

        <button class="primary-button" :disabled="!connected" @click="createRoom">
          <span>建立新戰局</span><span class="button-arrow">↗</span>
        </button>
        <div class="divider"><span>或加入朋友的戰局</span></div>
        <div class="join-row">
          <input v-model="roomCodeInput" maxlength="5" placeholder="輸入房間代碼" aria-label="房間代碼" @keyup.enter="joinRoom" />
          <button class="join-button" :disabled="!connected" @click="joinRoom">加入</button>
        </div>
        <p v-if="errorMessage" class="error-message" role="alert">{{ errorMessage }}</p>
        <div class="lobby-foot"><span>⚔</span> 最多 2 位玩家 · 即時同步 · 無需註冊</div>
      </div>
    </section>

    <section v-else class="game-layout">
      <div class="game-heading">
        <div>
          <div class="eyebrow"><span></span> {{ isWaiting ? '等待對手加入' : room.status === 'finished' ? '戰局結束' : '戰役進行中' }}</div>
          <h1>{{ isWaiting ? '你的戰場已準備就緒' : room.status === 'finished' ? (hasWon ? '旗開得勝。' : '下次再戰。') : '為你的王國而戰。' }}</h1>
        </div>
        <div class="room-code"><span>房間代碼</span><strong>{{ room.code }}</strong><button title="複製房間代碼" @click="copyRoomCode">複製</button></div>
      </div>

      <div class="game-content">
        <aside class="side-panel">
          <div class="panel-heading"><span>⚑</span> 戰場情報 <span class="live-dot"></span></div>
          <div v-for="player in room.players" :key="player.id" class="player-card" :class="{ 'is-me': player.id === myId }">
            <div class="player-top">
              <span class="team-emblem" :class="`team-${player.team}`">{{ player.team === 0 ? '✦' : '⚔' }}</span>
              <div class="player-info"><strong>{{ player.name }}<small v-if="player.id === myId">你</small></strong><span>{{ player.team === 0 ? '赤焰王國' : '蒼狼聯盟' }}</span></div>
              <span class="online-dot" :class="{ offline: !player.connected }"></span>
            </div>
            <div class="castle-health"><div><span>城堡耐久</span><span>{{ player.castleHp }}%</span></div><i><b :class="`health-${player.team}`" :style="{ width: `${player.castleHp}%` }"></b></i></div>
          </div>

          <div class="resource-section">
            <div class="panel-subheading">你的資源</div>
            <div class="resource-item"><span class="resource-icon food-icon">✿</span><span>食物</span><strong>{{ displayResource(me?.resources.food) }}</strong></div>
            <div class="resource-item"><span class="resource-icon wood-icon">♧</span><span>木材</span><strong>{{ displayResource(me?.resources.wood) }}</strong></div>
            <div class="resource-item"><span class="resource-icon gold-icon">◈</span><span>黃金</span><strong>{{ displayResource(me?.resources.gold) }}</strong></div>
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
            <svg class="battle-map" viewBox="0 0 1000 650" preserveAspectRatio="xMidYMid meet" role="application" aria-label="戰場地圖，選取部隊後點擊地面移動" @click="handleMapClick">
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
              <g v-for="unit in room.units" :key="unit.id" class="map-unit" :class="{ selected: selectedIds.includes(unit.id), 'enemy-unit': unit.owner !== myId }" :transform="`translate(${pointFor(unit).x} ${pointFor(unit).y})`" @click.stop="unit.owner === myId && toggleUnit(unit)">
                <ellipse cy="5" rx="11" ry="5" fill="#213027" opacity=".55" />
                <circle v-if="selectedIds.includes(unit.id)" cy="1" r="15" fill="none" stroke="#f3d37e" stroke-width="2" stroke-dasharray="3 3" />
                <circle cy="-5" r="9" :fill="getPlayerForUnit(unit)?.team === 0 ? (unit.type === 'worker' ? '#e5b075' : '#c16d56') : (unit.type === 'worker' ? '#a9c5bd' : '#6996a0')" stroke="#f3dfb2" stroke-width="1.5" />
                <path :d="unit.type === 'worker' ? 'M0 -9l-3 -8 6 0zM-4 -1v-5q4-4 8 0v5' : 'M0 -7l4 -6 -1 8 5 -1 -7 8 -1 -6 -4 1z'" fill="#fff1cd" stroke="#5d4834" stroke-width=".8" />
                <rect x="-10" y="-23" width="20" height="3" rx="1.5" fill="#26342b" /><rect x="-10" y="-23" :width="20 * (unit.hp / (unit.type === 'worker' ? 40 : 70))" height="3" rx="1.5" fill="#a3c77a" />
                <text y="18" text-anchor="middle" fill="#f3e7c8" font-size="9" font-weight="600">{{ unit.type === 'worker' ? '村民' : '劍士' }}</text>
              </g>
              <g v-if="room.units.length === 0" transform="translate(500 320)" pointer-events="none"><text text-anchor="middle" fill="#eee2be" font-size="17">等待戰局開始…</text><text y="25" text-anchor="middle" fill="#d8cca9" font-size="12">朋友加入後，村民就會抵達戰場</text></g>
            </svg>
            <div v-if="isWaiting" class="waiting-overlay"><div class="waiting-card"><span class="waiting-spinner"></span><strong>等待另一位領主加入</strong><p>將房間代碼分享給朋友</p><div>{{ room.code }}</div></div></div>
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
