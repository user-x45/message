// ===== 管理者設定 =====
// デプロイしたCloudflare WorkersのURLをここに直接書き換えてください。
// 例: "https://gartic-clone.yourname.workers.dev"
const WORKER_URL = "https://gartic-clone.yourname.workers.dev";

// ===== 基本ユーティリティ =====
const $ = (id) => document.getElementById(id);

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxxxxxx".replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
}

function genRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 紛らわしい文字を除外
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function getPlayerId() {
  let id = localStorage.getItem("gartic_player_id");
  if (!id) {
    id = uuid();
    localStorage.setItem("gartic_player_id", id);
  }
  return id;
}

function wsUrlFromHttp(httpUrl) {
  return httpUrl.replace(/^http/, "ws").replace(/\/$/, "");
}

// ===== 画面切り替え =====
const SCREENS = ["home", "lobby", "write", "draw", "waiting", "reveal"];
function showScreen(name) {
  for (const s of SCREENS) {
    $(`screen-${s}`).hidden = s !== name;
  }
}

// ===== グローバル状態 =====
let ws = null;
let myId = getPlayerId();
let myName = "";
let roomCode = "";
let isHost = false;
let latestState = null;
let currentTurn = null;
let timerInterval = null;
let revealChains = [];
let revealIndex = 0;

// お絵描き用
let drawing = false;
let strokes = []; // for undo: array of {points:[[x,y]], color, size}
let currentStroke = null;
let canvas, ctx;

// ===== 起動時の初期値読み込み =====
window.addEventListener("DOMContentLoaded", () => {
  canvas = $("drawCanvas");
  ctx = canvas.getContext("2d");
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const savedName = localStorage.getItem("gartic_name") || "";
  $("nameInput").value = savedName;

  // URLパラメータでの招待 (?room=CODE)
  const params = new URLSearchParams(location.search);
  const roomFromUrl = params.get("room");
  if (roomFromUrl) {
    $("codeInput").value = roomFromUrl.toUpperCase();
  }

  bindEvents();
  setupCanvasEvents();
  showScreen("home");
});

function bindEvents() {
  $("btnCreate").addEventListener("click", () => {
    if (!validateBasics()) return;
    const code = genRoomCode();
    connectRoom(code, true);
  });

  $("btnJoin").addEventListener("click", () => {
    if (!validateBasics()) return;
    const code = ($("codeInput").value || "").trim().toUpperCase();
    if (!code) {
      showHomeError("招待コードを入力してください。");
      return;
    }
    connectRoom(code, false);
  });

  $("btnCopyLink").addEventListener("click", () => {
    $("inviteLinkInput").select();
    navigator.clipboard?.writeText($("inviteLinkInput").value).catch(() => {});
    document.execCommand && document.execCommand("copy");
    flashBtn("btnCopyLink", "コピーしました！");
  });

  $("btnCopyCode").addEventListener("click", () => {
    navigator.clipboard?.writeText(roomCode).catch(() => {});
    flashBtn("btnCopyCode", "コピーしました！");
  });

  $("btnStart").addEventListener("click", () => {
    const drawSeconds = parseInt($("drawSecondsInput").value, 10) || 70;
    const writeSeconds = parseInt($("writeSecondsInput").value, 10) || 45;
    send({ type: "start", settings: { drawSeconds, writeSeconds } });
  });

  $("writeInput").addEventListener("input", () => {
    $("writeCharCount").textContent = $("writeInput").value.length;
  });

  $("btnSubmitText").addEventListener("click", () => {
    const val = $("writeInput").value.trim();
    if (!val) return;
    send({ type: "submit", content: val });
    stopTimer();
  });

  $("btnSubmitDrawing").addEventListener("click", () => {
    const dataUrl = canvas.toDataURL("image/png");
    send({ type: "submit", content: dataUrl });
    stopTimer();
  });

  $("btnUndo").addEventListener("click", () => {
    strokes.pop();
    redrawCanvas();
  });
  $("btnClear").addEventListener("click", () => {
    strokes = [];
    redrawCanvas();
  });

  $("btnRevealPrevChain").addEventListener("click", () => {
    revealIndex = (revealIndex - 1 + revealChains.length) % revealChains.length;
    renderRevealChain();
  });
  $("btnRevealNextChain").addEventListener("click", () => {
    revealIndex = (revealIndex + 1) % revealChains.length;
    renderRevealChain();
  });

  $("btnRestart").addEventListener("click", () => {
    send({ type: "restart" });
  });
}

function flashBtn(id, text) {
  const el = $(id);
  const original = el.textContent;
  el.textContent = text;
  setTimeout(() => (el.textContent = original), 1400);
}

function validateBasics() {
  hideHomeError();
  if (!WORKER_URL || !/^https?:\/\//.test(WORKER_URL)) {
    showHomeError("サーバーURLが未設定です。app.js内のWORKER_URLを管理者が設定してください。");
    return false;
  }
  const name = $("nameInput").value.trim();
  if (!name) {
    showHomeError("名前を入力してください。");
    return false;
  }
  localStorage.setItem("gartic_name", name);
  myName = name;
  return true;
}

function showHomeError(msg) {
  $("homeError").textContent = msg;
  $("homeError").hidden = false;
}
function hideHomeError() {
  $("homeError").hidden = true;
}

// ===== WebSocket接続 =====
function connectRoom(code, asHost) {
  const base = wsUrlFromHttp(WORKER_URL);
  const url = `${base}/room/${code}/ws?name=${encodeURIComponent(myName)}&id=${encodeURIComponent(myId)}&create=${asHost ? "1" : "0"}`;

  roomCode = code;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    showHomeError("接続に失敗しました。サーバーURLを確認してください。");
    return;
  }

  ws.addEventListener("open", () => {
    hideHomeError();
  });

  ws.addEventListener("message", (evt) => {
    const msg = JSON.parse(evt.data);
    handleServerMessage(msg);
  });

  ws.addEventListener("close", (evt) => {
    if (!latestState) {
      showHomeError("部屋が見つからないか、接続できませんでした。コードとURLを確認してください。");
      showScreen("home");
    }
  });

  ws.addEventListener("error", () => {
    if (!latestState) {
      showHomeError("接続エラーが発生しました。サーバーURLを確認してください。");
    }
  });
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// ===== サーバーメッセージ処理 =====
function handleServerMessage(msg) {
  switch (msg.type) {
    case "welcome":
      isHost = !!msg.you.isHost;
      latestState = msg.state;
      setupLobbyView();
      showScreen("lobby");
      renderLobby();
      break;
    case "state":
      latestState = msg.state;
      const me = latestState.players.find((p) => p.id === myId);
      if (me) isHost = !!me.isHost;
      if (latestState.phase === "lobby") renderLobby();
      if (latestState.phase === "playing") updateWaitingCount();
      break;
    case "your_turn":
      currentTurn = msg.turn;
      renderTurn();
      break;
    case "waiting":
      showScreen("waiting");
      updateWaitingCount();
      break;
    case "reveal":
      revealChains = msg.chains;
      revealIndex = 0;
      showScreen("reveal");
      $("revealHostControls").hidden = !isHost;
      renderRevealChain();
      break;
    case "error":
      alert(msg.message);
      break;
  }
}

// ===== ロビー =====
function setupLobbyView() {
  $("roomBadge").hidden = false;
  $("roomCodeLabel").textContent = roomCode;
  const link = `${location.origin}${location.pathname}?room=${roomCode}`;
  $("inviteLinkInput").value = link;
  $("inviteCodeDisplay").textContent = roomCode;
}

function renderLobby() {
  if (!latestState) return;
  $("playerCount").textContent = `(${latestState.players.length}人)`;
  const list = $("playerList");
  list.innerHTML = "";
  for (const p of latestState.players) {
    const li = document.createElement("li");
    if (!p.connected) li.classList.add("offline");
    const left = document.createElement("span");
    left.innerHTML = `<span class="pname">${escapeHtml(p.name)}</span>${p.isHost ? '<span class="tag">ホスト</span>' : ""}${!p.connected ? '<span class="tag">切断中</span>' : ""}`;
    li.appendChild(left);
    if (isHost && p.id !== myId) {
      const kickBtn = document.createElement("button");
      kickBtn.className = "kick-btn";
      kickBtn.textContent = "削除";
      kickBtn.addEventListener("click", () => send({ type: "kick", id: p.id }));
      li.appendChild(kickBtn);
    }
    list.appendChild(li);
  }
  $("hostControls").hidden = !isHost;
  $("lobbyNote").hidden = isHost;
}

// ===== ターン処理 =====
function renderTurn() {
  if (!currentTurn) return;
  const roundText = `ラウンド ${currentTurn.round + 1} / ${currentTurn.totalRounds}`;

  if (currentTurn.expect === "text") {
    showScreen("write");
    $("roundLabel").textContent = roundText;
    $("writeInput").value = "";
    $("writeCharCount").textContent = "0";
    if (currentTurn.round === 0) {
      $("promptFirstWrap").hidden = false;
      $("promptDrawingWrap").hidden = true;
    } else {
      $("promptFirstWrap").hidden = true;
      $("promptDrawingWrap").hidden = false;
      $("promptDrawingImg").src = currentTurn.prompt;
    }
    startTimer(currentTurn.seconds, () => {
      const val = $("writeInput").value.trim() || "（未回答）";
      send({ type: "submit", content: val });
    });
  } else {
    showScreen("draw");
    $("roundLabelDraw").textContent = roundText;
    $("promptTextValue").textContent = currentTurn.prompt;
    strokes = [];
    redrawCanvas();
    startTimer(currentTurn.seconds, () => {
      const dataUrl = canvas.toDataURL("image/png");
      send({ type: "submit", content: dataUrl });
    }, "timerLabelDraw");
  }
}

function updateWaitingCount() {
  if (!latestState) return;
  $("waitingCount").textContent = `${latestState.submittedCount} / ${latestState.connectedCount}`;
}

// ===== タイマー =====
function startTimer(seconds, onExpire, labelId = "timerLabel") {
  stopTimer();
  let remaining = seconds;
  const label = $(labelId);
  const render = () => {
    label.textContent = `${remaining}秒`;
    label.classList.toggle("low", remaining <= 10);
  };
  render();
  timerInterval = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      stopTimer();
      onExpire();
      return;
    }
    render();
  }, 1000);
}
function stopTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
}

// ===== お絵描きキャンバス =====
function setupCanvasEvents() {
  const getPos = (evt) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const clientX = evt.touches ? evt.touches[0].clientX : evt.clientX;
    const clientY = evt.touches ? evt.touches[0].clientY : evt.clientY;
    return [(clientX - rect.left) * scaleX, (clientY - rect.top) * scaleY];
  };

  const start = (evt) => {
    evt.preventDefault();
    drawing = true;
    currentStroke = {
      color: $("colorPicker").value,
      size: parseInt($("brushSize").value, 10),
      points: [getPos(evt)],
    };
  };
  const move = (evt) => {
    if (!drawing) return;
    evt.preventDefault();
    currentStroke.points.push(getPos(evt));
    redrawCanvas();
  };
  const end = () => {
    if (!drawing) return;
    drawing = false;
    if (currentStroke && currentStroke.points.length > 0) strokes.push(currentStroke);
    currentStroke = null;
  };

  canvas.addEventListener("mousedown", start);
  canvas.addEventListener("mousemove", move);
  window.addEventListener("mouseup", end);
  canvas.addEventListener("touchstart", start, { passive: false });
  canvas.addEventListener("touchmove", move, { passive: false });
  canvas.addEventListener("touchend", end);
}

function redrawCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const all = currentStroke ? [...strokes, currentStroke] : strokes;
  for (const stroke of all) {
    if (stroke.points.length === 0) continue;
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.size;
    ctx.beginPath();
    ctx.moveTo(stroke.points[0][0], stroke.points[0][1]);
    for (const pt of stroke.points.slice(1)) ctx.lineTo(pt[0], pt[1]);
    if (stroke.points.length === 1) ctx.lineTo(stroke.points[0][0] + 0.1, stroke.points[0][1] + 0.1);
    ctx.stroke();
  }
}

// ===== 結果発表 =====
function renderRevealChain() {
  if (!revealChains.length) return;
  const chain = revealChains[revealIndex];
  $("revealChainOwner").textContent = `${chain.ownerName} さんのお題から…`;
  $("revealChainIndicator").textContent = `${revealIndex + 1} / ${revealChains.length}`;
  const track = $("revealTrack");
  track.innerHTML = "";
  chain.entries.forEach((entry, i) => {
    const div = document.createElement("div");
    div.className = "reveal-item";
    const who = document.createElement("div");
    who.className = "who";
    who.textContent = `${i + 1}手目 — ${entry ? entry.authorName : "?"}`;
    div.appendChild(who);
    if (entry && entry.type === "text") {
      const bubble = document.createElement("div");
      bubble.className = "text-bubble";
      bubble.textContent = entry.content;
      div.appendChild(bubble);
    } else if (entry && entry.type === "drawing") {
      const img = document.createElement("img");
      img.src = entry.content;
      div.appendChild(img);
    }
    track.appendChild(div);
  });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
