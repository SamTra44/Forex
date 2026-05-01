'use strict';

// ---------- API ----------
const API = {
  token: () => localStorage.getItem('token'),
  setSession: (token, user) => {
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
  },
  user: () => {
    try { return JSON.parse(localStorage.getItem('user') || 'null'); } catch { return null; }
  },
  clear: () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
  },
  async req(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    const t = API.token();
    if (t) headers.Authorization = `Bearer ${t}`;
    const res = await fetch(path, { ...opts, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  },
};

// ---------- Toasts ----------
function toast(message, type = 'info') {
  const el = document.createElement('div');
  const colors = {
    info: 'bg-card border-accent2 text-gray-100',
    success: 'bg-card border-accent text-accent',
    error: 'bg-card border-danger text-danger',
  };
  el.className = `toast-enter ${colors[type] || colors.info} border rounded-lg px-4 py-3 text-sm shadow-lg max-w-sm`;
  el.textContent = message;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ---------- Helpers ----------
const $ = (id) => document.getElementById(id);
function fmt(n) {
  return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s.replace(' ', 'T') + 'Z');
  return d.toLocaleString();
}
function txTypeLabel(t) {
  return {
    deposit: { label: 'Deposit', cls: 'text-accent2' },
    withdrawal: { label: 'Withdrawal', cls: 'text-orange-400' },
    referral_bonus: { label: 'Referral Bonus', cls: 'text-accent' },
    admin_credit: { label: 'Admin Credit', cls: 'text-yellow-400' },
    bot_trade: { label: 'Bot Trade', cls: 'text-purple-400' },
    usdt_buy: { label: 'Withdraw → Wallet', cls: 'text-yellow-400' },
    usdt_sell: { label: 'Add Fund', cls: 'text-accent2' },
    ref_signup_bonus: { label: 'Joining Bonus', cls: 'text-accent' },
    ref_commission: { label: 'Referral Commission', cls: 'text-yellow-400' },
    ref_achievement: { label: 'Achievement Bonus', cls: 'text-purple-400' },
    ref_to_trading: { label: 'Commission → Trading', cls: 'text-accent2' },
    ref_withdraw: { label: 'Commission Withdraw', cls: 'text-orange-400' },
    bonus_to_trading: { label: 'Bonus → Trading', cls: 'text-accent2' },
    bonus_withdraw: { label: 'Bonus Withdraw', cls: 'text-orange-400' },
    bonus_credit: { label: 'Admin Bonus Credit', cls: 'text-yellow-400' },
  }[t] || { label: t, cls: 'text-gray-300' };
}
function fmt6(n) {
  return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 6, maximumFractionDigits: 6 });
}
function show(viewId) {
  ['view-auth', 'view-dashboard', 'view-admin'].forEach(id => $(id).classList.add('hidden'));
  $(viewId).classList.remove('hidden');
}

// ---------- Auth tab toggle ----------
document.querySelectorAll('.auth-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.auth-tab').forEach(b => {
      b.classList.remove('tab-active', 'border-accent', 'text-accent');
      b.classList.add('border-transparent', 'text-muted');
    });
    btn.classList.add('border-accent', 'text-accent');
    btn.classList.remove('border-transparent', 'text-muted');
    $('form-login').classList.toggle('hidden', tab !== 'login');
    $('form-signup').classList.toggle('hidden', tab !== 'signup');
  });
});

// ---------- Auth submit ----------
$('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    const data = await API.req('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: fd.get('email'), password: fd.get('password') }),
    });
    API.setSession(data.token, data.user);
    toast('Welcome back', 'success');
    routeAfterAuth();
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('form-signup').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    const data = await API.req('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        name: fd.get('name'),
        email: fd.get('email'),
        password: fd.get('password'),
        referralCode: fd.get('referralCode') || null,
      }),
    });
    API.setSession(data.token, data.user);
    toast('Account created', 'success');
    routeAfterAuth();
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ---------- Logout ----------
$('btn-logout').addEventListener('click', logout);
$('btn-logout-admin').addEventListener('click', logout);
function logout() {
  if (typeof stopDashboardPolling === 'function') stopDashboardPolling();
  API.clear();
  show('view-auth');
}

// ---------- Routing ----------
function routeAfterAuth() {
  const u = API.user();
  if (!u) return show('view-auth');
  if (u.is_admin) {
    show('view-admin');
    loadAdmin();
  } else {
    show('view-dashboard');
    loadDashboard();
  }
}

// ---------- Chart (real Binance data) ----------
const chartState = {
  chart: null,
  series: null,
  symbol: 'btcusdt',
  interval: '5m',
  ws: null,
  tickerTimer: null,
  reconnectTimer: null,
  resizeObserver: null,
};

async function initChart() {
  const el = $('chart-container');
  if (!el || chartState.chart) return;
  if (typeof LightweightCharts === 'undefined') return;

  chartState.chart = LightweightCharts.createChart(el, {
    layout: { background: { color: '#161e2e' }, textColor: '#9ca3af', fontSize: 11 },
    grid: { vertLines: { color: '#1f2937' }, horzLines: { color: '#1f2937' } },
    timeScale: { borderColor: '#1f2937', timeVisible: true, secondsVisible: false },
    rightPriceScale: { borderColor: '#1f2937' },
    crosshair: { mode: 1 },
    width: el.clientWidth,
    height: 360,
  });
  chartState.series = chartState.chart.addCandlestickSeries({
    upColor: '#22d3a7', downColor: '#ef4444',
    borderUpColor: '#22d3a7', borderDownColor: '#ef4444',
    wickUpColor: '#22d3a7', wickDownColor: '#ef4444',
  });

  await loadChartHistory();
  connectChartStream();
  refreshTicker();
  if (chartState.tickerTimer) clearInterval(chartState.tickerTimer);
  chartState.tickerTimer = setInterval(refreshTicker, 15000);

  window.addEventListener('resize', () => {
    if (chartState.chart) chartState.chart.applyOptions({ width: el.clientWidth });
  });

  // Symbol switcher
  const sel = $('chart-symbol-select');
  if (sel) sel.addEventListener('change', () => switchSymbol(sel.value));
  const ivSel = $('chart-interval-select');
  if (ivSel) ivSel.addEventListener('change', () => switchInterval(ivSel.value));
}

async function switchSymbol(sym) {
  chartState.symbol = sym;
  await loadChartHistory();
  connectChartStream();
  refreshTicker();
}

async function switchInterval(iv) {
  chartState.interval = iv;
  await loadChartHistory();
  connectChartStream();
}

async function loadChartHistory() {
  if (!chartState.series) return;
  try {
    const sym = chartState.symbol.toUpperCase();
    const url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${chartState.interval}&limit=200`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('binance klines ' + res.status);
    const data = await res.json();
    const bars = data.map(k => ({
      time: Math.floor(k[0] / 1000),
      open: +k[1], high: +k[2], low: +k[3], close: +k[4],
    }));
    chartState.series.setData(bars);
    if (bars.length) {
      const last = bars[bars.length - 1];
      $('chart-price').textContent = last.close.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
  } catch (err) {
    console.warn('chart history failed:', err.message);
  }
}

function connectChartStream() {
  if (chartState.ws) {
    try { chartState.ws.onclose = null; chartState.ws.close(); } catch {}
    chartState.ws = null;
  }
  if (chartState.reconnectTimer) { clearTimeout(chartState.reconnectTimer); chartState.reconnectTimer = null; }

  const url = `wss://stream.binance.com:9443/ws/${chartState.symbol}@kline_${chartState.interval}`;
  let ws;
  try { ws = new WebSocket(url); } catch { return; }
  chartState.ws = ws;

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      const k = msg.k;
      if (!k) return;
      const bar = {
        time: Math.floor(k.t / 1000),
        open: +k.o, high: +k.h, low: +k.l, close: +k.c,
      };
      chartState.series.update(bar);
      $('chart-price').textContent = bar.close.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    } catch {}
  };
  ws.onerror = () => {};
  ws.onclose = () => {
    if (chartState.ws !== ws) return; // newer connection took over
    chartState.reconnectTimer = setTimeout(connectChartStream, 2500);
  };
}

async function refreshTicker() {
  try {
    const sym = chartState.symbol.toUpperCase();
    const res = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${sym}`);
    if (!res.ok) return;
    const d = await res.json();
    const change = +d.priceChange;
    const pct = +d.priceChangePercent;
    const el = $('chart-change');
    const sign = change >= 0 ? '+' : '';
    el.textContent = `${sign}${change.toFixed(2)} (${sign}${pct.toFixed(2)}%) 24h`;
    el.className = `text-xs px-2 py-0.5 rounded ${change >= 0 ? 'bg-accent/10 text-accent' : 'bg-danger/10 text-danger'}`;
  } catch {}
}

// ---------- Animated number ----------
function animateBalance(el, target) {
  const current = parseFloat(el.textContent.replace(/,/g, '')) || 0;
  if (Math.abs(current - target) < 0.01) {
    el.textContent = fmt(target);
    return;
  }
  const start = performance.now();
  const duration = 600;
  function frame(t) {
    const p = Math.min(1, (t - start) / duration);
    const v = current + (target - current) * p;
    el.textContent = fmt(v);
    if (p < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// ---------- User dashboard ----------
let dashboardPollTimer = null;
let lastBotTradeId = 0;
let lastBotToastAt = 0;
let prevBalance = null;

async function loadDashboard() {
  try {
    const [me, txs, refs, trades, botStatus] = await Promise.all([
      API.req('/api/me'),
      API.req('/api/me/transactions'),
      API.req('/api/me/referrals'),
      API.req('/api/me/bot/trades'),
      API.req('/api/me/bot/status'),
    ]);
    const u = me.user;
    $('user-name-pill').textContent = u.name;
    $('greet-name').textContent = u.name.split(' ')[0];
    animateBalance($('stat-balance'), Number(u.balance));
    renderUsdt(u, me.usdt_price);
    renderProfile(u);
    renderRefWallet(u);
    $('stat-commission').textContent = fmt(Number(u.referral_balance || 0));
    $('stat-bonus').textContent = fmt(Number(u.bonus_balance || 0));
    $('stat-ref-count').textContent = refs.referrals.length;
    $('referral-count-badge').textContent = refs.referrals.length;
    $('referral-code').textContent = u.referral_code;

    // Today's P&L = realized daily P&L from server
    const pnl = Number(botStatus.daily_pnl) || 0;
    $('stat-pnl').textContent = fmt(Math.abs(pnl));
    $('stat-pnl-sign').textContent = pnl >= 0 ? '+' : '-';
    $('stat-pnl-wrap').className = 'text-2xl font-bold ' + (pnl >= 0 ? 'text-accent' : 'text-danger');
    $('stat-trades-count').textContent = trades.trades.length;

    const wins = trades.trades.filter(t => Number(t.amount) > 0).length;
    const losses = trades.trades.filter(t => Number(t.amount) < 0).length;
    $('bot-wins').textContent = wins;
    $('bot-losses').textContent = losses;

    // Bot mode + target
    const isProfit = botStatus.is_profit_day;
    const targetPnl = Number(botStatus.target_pnl);
    const targetPctNum = Number(botStatus.target_pct || 0);
    const targetPctStr = (targetPctNum * 100).toFixed(targetPctNum >= 0.10 ? 0 : 1);
    const mode = botStatus.mode || (isProfit ? 'profit' : 'loss');
    const modeBadge = $('bot-mode-badge');
    let topLabel = 'Profit Day';
    let topSub = 'Targeting +1%';
    if (mode === 'boom') {
      modeBadge.textContent = `🚀 BOOM +${targetPctStr}%`;
      modeBadge.className = 'px-1.5 py-0.5 rounded text-[10px] bg-yellow-400/15 text-yellow-400 font-bold';
      topLabel = 'Boom Day 🚀';
      topSub = `Targeting +${targetPctStr}%`;
    } else if (mode === 'recovery') {
      modeBadge.textContent = `RECOVERY -$${fmt(Math.abs(targetPnl))}`;
      modeBadge.className = 'px-1.5 py-0.5 rounded text-[10px] bg-orange-400/15 text-orange-400';
      topLabel = 'Recovery';
      topSub = `Cooling -$${fmt(Math.abs(targetPnl))}`;
    } else if (isProfit) {
      modeBadge.textContent = 'PROFIT +1%';
      modeBadge.className = 'px-1.5 py-0.5 rounded text-[10px] bg-accent/10 text-accent';
      topLabel = 'Profit Day';
      topSub = 'Targeting +1%';
    } else {
      modeBadge.textContent = 'DRAWDOWN -0.5%';
      modeBadge.className = 'px-1.5 py-0.5 rounded text-[10px] bg-danger/10 text-danger';
      topLabel = 'Risk Day';
      topSub = 'Capped -0.5%';
    }
    $('bot-target').textContent = (targetPnl >= 0 ? '+' : '-') + '$' + fmt(Math.abs(targetPnl));
    $('bot-target').className = 'font-mono text-sm ' + (isProfit ? (mode === 'boom' ? 'text-yellow-400' : 'text-accent') : 'text-danger');
    $('bot-realized').textContent = (pnl >= 0 ? '+' : '-') + '$' + fmt(Math.abs(pnl));
    $('bot-realized').className = 'font-mono text-sm ' + (pnl >= 0 ? 'text-accent' : 'text-danger');
    const barEl = $('bot-target-bar');
    barEl.style.width = `${Math.max(0, Math.min(100, botStatus.progress_pct))}%`;
    barEl.className = 'h-full transition-all ' + (mode === 'boom' ? 'bg-yellow-400' : (isProfit ? 'bg-accent' : 'bg-danger'));

    // Top stat card mirror
    if (Number(u.balance) > 0) {
      $('bot-status-text').textContent = topLabel;
      const cls = mode === 'boom' ? 'text-yellow-400' : (mode === 'recovery' ? 'text-orange-400' : (isProfit ? 'text-accent' : 'text-danger'));
      $('bot-status-text').className = 'text-2xl font-bold ' + cls;
      $('bot-status-sub').textContent = topSub;
    } else {
      $('bot-status-text').textContent = 'Armed';
      $('bot-status-text').className = 'text-2xl font-bold text-muted';
      $('bot-status-sub').textContent = 'Deposit to begin';
    }

    // Live trades feed
    renderBotTrades(trades.trades);

    // Notify deposit arrivals
    notifyDepositArrivals(txs.transactions);

    // Toast on new trade — max 1 per minute (just the most recent)
    if (trades.trades.length && trades.trades[0].id > lastBotTradeId && lastBotTradeId !== 0) {
      if (Date.now() - lastBotToastAt > 60_000) {
        const t = trades.trades[0];
        const sign = t.amount >= 0 ? '+' : '';
        toast(`${t.note}: ${sign}$${fmt(Math.abs(t.amount))}`, t.amount >= 0 ? 'success' : 'error');
        lastBotToastAt = Date.now();
      }
    }
    if (trades.trades.length) lastBotTradeId = trades.trades[0].id;

    // Transactions
    const tbody = $('tbody-tx');
    tbody.innerHTML = '';
    if (txs.transactions.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" class="text-center text-muted py-8 text-sm">No transactions yet</td></tr>`;
    } else {
      txs.transactions.slice(0, 50).forEach(t => {
        const tt = txTypeLabel(t.type);
        const isUsdtType = String(t.type).startsWith('usdt_');
        const usdtAmt = Number(t.usdt_amount || 0);
        const usdAmt = Number(t.amount || 0);
        const isWithdrawType = (t.type === 'withdrawal' || t.type === 'usdt_withdraw');
        const statusPill = (isWithdrawType && t.status && t.status !== 'completed')
          ? ' ' + wdStatusBadgeInline(t.status)
          : '';
        let amountCell;
        if (isUsdtType && Math.abs(usdtAmt) > 0) {
          const sign = usdtAmt >= 0 ? '+' : '';
          amountCell = `<span class="font-mono ${usdtAmt >= 0 ? 'text-accent' : 'text-danger'}">${sign}${fmt6(Math.abs(usdtAmt))} USDT</span>` +
            (Math.abs(usdAmt) > 0 ? `<div class="text-[10px] text-muted">${usdAmt >= 0 ? '+' : '-'}$${fmt(Math.abs(usdAmt))}</div>` : '');
        } else {
          const sign = usdAmt >= 0 ? '+' : '';
          amountCell = `<span class="font-mono ${usdAmt >= 0 ? 'text-accent' : 'text-danger'}">${sign}$${fmt(Math.abs(usdAmt))}</span>`;
        }
        const tr = document.createElement('tr');
        tr.className = 'border-t border-line';
        tr.innerHTML = `
          <td class="px-5 py-2.5 text-muted text-xs">${fmtDate(t.created_at)}</td>
          <td class="px-5 py-2.5"><span class="${tt.cls}">${tt.label}</span>${statusPill}</td>
          <td class="px-5 py-2.5 text-gray-400">${escapeHtml(t.note || '')}</td>
          <td class="px-5 py-2.5 text-right">${amountCell}</td>
        `;
        tbody.appendChild(tr);
      });
    }

    // Referrals
    const rbody = $('tbody-referrals');
    rbody.innerHTML = '';
    if (refs.referrals.length === 0) {
      rbody.innerHTML = `<tr><td colspan="3" class="text-center text-muted py-8 text-sm">No referrals yet — share your code to earn $30 each</td></tr>`;
    } else {
      refs.referrals.forEach(r => {
        const tr = document.createElement('tr');
        tr.className = 'border-t border-line';
        tr.innerHTML = `
          <td class="px-5 py-2.5 text-muted text-xs">${fmtDate(r.created_at)}</td>
          <td class="px-5 py-2.5">${escapeHtml(r.name)}</td>
          <td class="px-5 py-2.5 text-gray-400">${escapeHtml(r.email)}</td>
        `;
        rbody.appendChild(tr);
      });
    }

    prevBalance = Number(u.balance);

    // Set up polling once
    if (!dashboardPollTimer) {
      initChart();
      initNetworkPanel();
      dashboardPollTimer = setInterval(loadDashboard, 2500);
    }
  } catch (err) {
    if (err.message.includes('unauthorized') || err.message.includes('invalid_token')) {
      stopDashboardPolling();
      logout();
    }
  }
}

function stopDashboardPolling() {
  if (dashboardPollTimer) { clearInterval(dashboardPollTimer); dashboardPollTimer = null; }
  if (chartState.tickerTimer) { clearInterval(chartState.tickerTimer); chartState.tickerTimer = null; }
  if (chartState.reconnectTimer) { clearTimeout(chartState.reconnectTimer); chartState.reconnectTimer = null; }
  if (chartState.ws) { try { chartState.ws.onclose = null; chartState.ws.close(); } catch {} chartState.ws = null; }
  if (networkState.timer) { clearInterval(networkState.timer); networkState.timer = null; }
  if (networkState.logTimer) { clearInterval(networkState.logTimer); networkState.logTimer = null; }
  lastBotTradeId = 0;
  lastBotToastAt = 0;
  prevBalance = null;
}

function renderBotTrades(trades) {
  const body = $('tbody-bot-trades');
  body.innerHTML = '';
  if (trades.length === 0) {
    body.innerHTML = `<tr><td colspan="5" class="text-center text-muted py-10 text-sm">Bot is idle. Start it to see live trades.</td></tr>`;
    return;
  }
  trades.forEach(t => {
    const sign = t.amount >= 0 ? '+' : '';
    const win = t.amount >= 0;
    const parts = (t.note || '').split(' ');
    const side = parts[0] || '?';
    const symbol = parts[1] || '';
    const status = parts.slice(2).join(' ') || '';
    const tr = document.createElement('tr');
    tr.className = 'border-t border-line hover:bg-bg/40';
    tr.innerHTML = `
      <td class="px-5 py-2.5 text-muted text-xs">${fmtDate(t.created_at)}</td>
      <td class="px-5 py-2.5"><span class="text-xs font-semibold px-2 py-0.5 rounded ${side === 'BUY' ? 'bg-accent/10 text-accent' : 'bg-accent2/10 text-accent2'}">${side}</span></td>
      <td class="px-5 py-2.5 font-medium">${escapeHtml(symbol)}</td>
      <td class="px-5 py-2.5"><span class="text-xs ${win ? 'text-accent' : 'text-danger'}">${escapeHtml(status)}</span></td>
      <td class="px-5 py-2.5 text-right font-mono ${win ? 'text-accent' : 'text-danger'}">${sign}$${fmt(Math.abs(t.amount))}</td>
    `;
    body.appendChild(tr);
  });
}

// ---------- Quantum Network panel (visual sim) ----------
const networkState = { timer: null, logTimer: null, logLines: [] };

const COUNTRIES = [
  { flag: '🇮🇸', name: 'Reykjavík' }, { flag: '🇨🇭', name: 'Zürich' }, { flag: '🇳🇱', name: 'Amsterdam' },
  { flag: '🇸🇪', name: 'Stockholm' }, { flag: '🇩🇪', name: 'Frankfurt' }, { flag: '🇫🇮', name: 'Helsinki' },
  { flag: '🇸🇬', name: 'Singapore' }, { flag: '🇯🇵', name: 'Tokyo' }, { flag: '🇨🇦', name: 'Toronto' },
  { flag: '🇺🇸', name: 'Ashburn' }, { flag: '🇬🇧', name: 'London' }, { flag: '🇭🇰', name: 'Hong Kong' },
  { flag: '🇦🇪', name: 'Dubai' }, { flag: '🇧🇷', name: 'São Paulo' }, { flag: '🇰🇷', name: 'Seoul' },
  { flag: '🇦🇺', name: 'Sydney' }, { flag: '🇫🇷', name: 'Paris' }, { flag: '🇮🇹', name: 'Milan' },
];

function randomIp() {
  return [
    185 + Math.floor(Math.random() * 50),
    Math.floor(Math.random() * 256),
    Math.floor(Math.random() * 256),
    Math.floor(Math.random() * 256),
  ].join('.');
}

function renderNetworkNodes() {
  const container = $('net-nodes');
  if (!container) return;
  const picks = [...COUNTRIES].sort(() => 0.5 - Math.random()).slice(0, 8);
  container.innerHTML = '';
  picks.forEach((c, i) => {
    const ip = randomIp();
    const lat = 4 + Math.floor(Math.random() * 80);
    const status = Math.random() < 0.92 ? 'OK' : 'SYNC';
    const isExit = i === 0;
    const div = document.createElement('div');
    div.className = `bg-bg border ${isExit ? 'border-accent/40' : 'border-line'} rounded-lg px-2.5 py-2 font-mono text-[10.5px]`;
    div.innerHTML = `
      <div class="flex items-center justify-between mb-0.5">
        <span class="text-sm">${c.flag}</span>
        <span class="text-[9px] uppercase ${isExit ? 'text-accent' : (status === 'OK' ? 'text-accent' : 'text-yellow-400')}">${isExit ? 'EXIT' : status}</span>
      </div>
      <div class="text-gray-300 truncate">${c.name}</div>
      <div class="text-muted truncate">${ip}</div>
      <div class="flex items-center justify-between mt-1">
        <div class="flex-1 h-0.5 bg-line rounded-full overflow-hidden mr-1.5">
          <div class="h-full ${isExit ? 'bg-accent' : 'bg-accent2'}" style="width: ${Math.min(100, 100 - lat)}%"></div>
        </div>
        <span class="text-muted">${lat}ms</span>
      </div>
    `;
    container.appendChild(div);
  });
  // header summary
  $('net-exit-flag').textContent = picks[0].flag;
  $('net-exit-ip').textContent = randomIp();
  $('net-latency').textContent = (8 + Math.random() * 18).toFixed(1);
  $('net-throughput').textContent = (120 + Math.random() * 380).toFixed(1);
}

function pad(n) { return n < 10 ? '0' + n : '' + n; }

function appendLog(line, color = 'text-gray-400') {
  const box = $('net-log');
  if (!box) return;
  const now = new Date();
  const ts = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const div = document.createElement('div');
  div.className = color;
  div.innerHTML = `<span class="text-muted">[${ts}]</span> ${line}`;
  box.appendChild(div);
  // keep last 14
  while (box.children.length > 14) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

function tickLog() {
  const c = COUNTRIES[Math.floor(Math.random() * COUNTRIES.length)];
  const ip = randomIp();
  const ms = (3 + Math.random() * 50).toFixed(1);
  const lines = [
    () => `<span class="text-accent">[net]</span> handshake ok ${c.flag} ${c.name} ${ip} (${ms}ms)`,
    () => `<span class="text-accent2">[tor]</span> circuit established · 7 hops · AES-256-GCM`,
    () => `<span class="text-accent">[exec]</span> ${['BUY','SELL'][Math.random()<.5?0:1]} ${SYMBOLS_LITE()} qty=${(Math.random()*0.5).toFixed(4)} @ ${(40000+Math.random()*40000).toFixed(2)}`,
    () => `<span class="text-yellow-400">[sig]</span> strategy=QQE-7 weight=${(0.6+Math.random()*0.4).toFixed(2)} edge=${(Math.random()*1.4).toFixed(3)}σ`,
    () => `<span class="text-purple-400">[risk]</span> max_dd=${(Math.random()*3).toFixed(2)}% var95=${(Math.random()*2).toFixed(2)}%`,
    () => `<span class="text-accent">[ob]</span> nasdaq depth=10000 imbalance=${(Math.random()*0.4-0.2).toFixed(3)}`,
    () => `<span class="text-accent2">[net]</span> rotating exit · ${c.flag} ${c.name} latency=${ms}ms`,
    () => `<span class="text-gray-300">[mempool]</span> sync ${(98 + Math.random()*2).toFixed(2)}% peers=${30+Math.floor(Math.random()*40)}`,
    () => `<span class="text-accent">[ml]</span> alpha-7 inference ${ms}ms confidence=${(70+Math.random()*30).toFixed(1)}%`,
    () => `<span class="text-yellow-400">[guard]</span> spoofing-detect ok · canary green`,
  ];
  const fn = lines[Math.floor(Math.random() * lines.length)];
  appendLog(fn());
}
function SYMBOLS_LITE() {
  const s = ['EUR/USD','BTC/USD','GOLD','ETH/USD','GBP/USD','NAS100','XAU/USD','AAPL'];
  return s[Math.floor(Math.random() * s.length)];
}

function initNetworkPanel() {
  if (networkState.timer || !$('net-nodes')) return;
  renderNetworkNodes();
  for (let i = 0; i < 6; i++) tickLog();
  networkState.timer = setInterval(renderNetworkNodes, 4500);
  networkState.logTimer = setInterval(tickLog, 1100);
}

// ---------- Profile + Referral Wallet + KYC ----------
function renderProfile(u) {
  $('profile-name').textContent = u.name || '—';
  $('profile-email').textContent = u.email || '—';
  $('profile-mobile').textContent = u.mobile_number || 'Not set';
  $('profile-joined').textContent = fmtDate(u.created_at);

  const badge = $('kyc-badge');
  const btn = $('btn-open-kyc');
  const reason = $('kyc-reject-reason');
  reason.classList.add('hidden');

  switch (u.kyc_status) {
    case 'approved':
      badge.textContent = '✓ KYC Verified';
      badge.className = 'text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-accent/10 text-accent border border-accent/30';
      btn.textContent = 'KYC Verified';
      btn.disabled = true;
      btn.className = 'mt-4 w-full bg-accent/20 text-accent font-semibold py-2.5 rounded-lg text-sm cursor-not-allowed';
      break;
    case 'pending':
      badge.textContent = '⏳ Under Review';
      badge.className = 'text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-yellow-400/10 text-yellow-400 border border-yellow-400/30';
      btn.textContent = 'Awaiting Admin Review';
      btn.disabled = true;
      btn.className = 'mt-4 w-full bg-yellow-400/20 text-yellow-400 font-semibold py-2.5 rounded-lg text-sm cursor-not-allowed';
      break;
    case 'rejected':
      badge.textContent = '✗ Rejected';
      badge.className = 'text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-danger/10 text-danger border border-danger/30';
      btn.textContent = 'Resubmit KYC';
      btn.disabled = false;
      btn.className = 'mt-4 w-full bg-accent hover:bg-accent/90 text-bg font-semibold py-2.5 rounded-lg text-sm transition';
      if (u.kyc_reject_reason) {
        reason.classList.remove('hidden');
        reason.textContent = 'Reason: ' + u.kyc_reject_reason;
      }
      break;
    default:
      badge.textContent = 'Not Verified';
      badge.className = 'text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-line text-muted';
      btn.textContent = 'Complete KYC';
      btn.disabled = false;
      btn.className = 'mt-4 w-full bg-accent hover:bg-accent/90 text-bg font-semibold py-2.5 rounded-lg text-sm transition';
  }
}

function renderWalletButtons(wallet, bal, kycApproved, hintEl) {
  const moveBtn = document.querySelector(`.btn-wallet-move[data-wallet="${wallet}"]`);
  const wdBtn   = document.querySelector(`.btn-wallet-withdraw[data-wallet="${wallet}"]`);
  if (!moveBtn || !wdBtn) return;
  const hasMin = bal >= 45;
  if (!hasMin) {
    moveBtn.disabled = true;
    moveBtn.className = 'btn-wallet-move bg-line text-muted font-semibold py-2 rounded-lg text-xs cursor-not-allowed';
    wdBtn.disabled = true;
    wdBtn.className = 'btn-wallet-withdraw bg-line text-muted font-semibold py-2 rounded-lg text-xs cursor-not-allowed';
    if (hintEl) hintEl.textContent = `Need $45 to use this wallet (have $${fmt(bal)}).`;
  } else {
    moveBtn.disabled = false;
    moveBtn.className = 'btn-wallet-move bg-accent2 hover:bg-accent2/90 text-white font-semibold py-2 rounded-lg text-xs transition';
    if (kycApproved) {
      wdBtn.disabled = false;
      wdBtn.className = 'btn-wallet-withdraw bg-accent hover:bg-accent/90 text-bg font-semibold py-2 rounded-lg text-xs transition';
      if (hintEl) hintEl.textContent = `Ready to use — $${fmt(bal)} available.`;
    } else {
      wdBtn.disabled = true;
      wdBtn.className = 'btn-wallet-withdraw bg-line text-muted font-semibold py-2 rounded-lg text-xs cursor-not-allowed';
      if (hintEl) hintEl.textContent = `Move-to-trading is open. KYC required to withdraw → USDT.`;
    }
  }
}

function renderRefWallet(u) {
  const commission = Number(u.referral_balance || 0);
  const bonus = Number(u.bonus_balance || 0);
  $('ref-balance').textContent = fmt(commission);
  $('bonus-balance').textContent = fmt(bonus);
  const kycOk = u.kyc_status === 'approved';
  renderWalletButtons('commission', commission, kycOk, $('ref-hint'));
  renderWalletButtons('bonus', bonus, kycOk, $('bonus-hint'));
}

// KYC modal
function readImageAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('No file'));
    if (file.size > 600 * 1024) return reject(new Error(`${file.name} is too large (max 600 KB)`));
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('read failed'));
    r.readAsDataURL(file);
  });
}

document.addEventListener('click', (e) => {
  if (!e.target) return;
  if (e.target.id === 'btn-open-kyc') {
    const u = API.user();
    $('form-kyc').reset();
    document.querySelectorAll('.kyc-preview').forEach(img => { img.classList.add('hidden'); img.src = ''; });
    if (u && u.mobile_number) {
      $('form-kyc').querySelector('input[name="mobile_number"]').value = u.mobile_number;
    }
    $('modal-kyc').classList.remove('hidden');
  }
  if (e.target.id === 'btn-kyc-cancel') $('modal-kyc').classList.add('hidden');

  // Referral commission / Joining bonus wallet actions (delegated by data-attr)
  const walletBtn = e.target.closest('[data-wallet]');
  if (walletBtn && !walletBtn.disabled) {
    const wallet = walletBtn.dataset.wallet; // 'commission' or 'bonus'
    const action = walletBtn.dataset.action; // 'move' or 'withdraw'
    const labelMap = { commission: 'Referral Commission', bonus: 'Joining Bonus' };
    const lbl = labelMap[wallet] || 'wallet';
    if (action === 'move') {
      const amt = prompt(`Move how much from ${lbl} wallet to trading? (USD)`);
      if (!amt) return;
      API.req(`/api/me/wallet/${wallet}/move-to-trading`, { method: 'POST', body: JSON.stringify({ amount: Number(amt) }) })
        .then(() => { toast(`Moved $${fmt(Number(amt))} to trading`, 'success'); loadDashboard(); })
        .catch(err => toast(err.message, 'error'));
    } else if (action === 'withdraw') {
      const amt = prompt(`Withdraw how much from ${lbl} wallet → USDT wallet? (USD)`);
      if (!amt) return;
      API.req(`/api/me/wallet/${wallet}/withdraw`, { method: 'POST', body: JSON.stringify({ amount: Number(amt) }) })
        .then(d => { toast(`Withdrew $${fmt(d.usd_withdrawn)} → ${fmt6(d.usdt_received)} USDT`, 'success'); loadDashboard(); })
        .catch(err => toast(err.message, 'error'));
    }
  }
});

// File previews + KYC submit
document.addEventListener('change', async (e) => {
  if (e.target && e.target.matches('#form-kyc input[type="file"]')) {
    const name = e.target.name;
    const file = e.target.files[0];
    const img = document.querySelector(`.kyc-preview[data-for="${name}"]`);
    if (!file || !img) return;
    try {
      const url = await readImageAsDataUrl(file);
      img.src = url;
      img.classList.remove('hidden');
    } catch (err) { toast(err.message, 'error'); }
  }
});

document.addEventListener('submit', async (e) => {
  if (e.target && e.target.id === 'form-kyc') {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const aadhar = await readImageAsDataUrl(fd.get('aadhar'));
      const pan = await readImageAsDataUrl(fd.get('pan'));
      const selfie = await readImageAsDataUrl(fd.get('selfie'));
      await API.req('/api/me/kyc', {
        method: 'POST',
        body: JSON.stringify({ aadhar, pan, selfie, mobile_number: fd.get('mobile_number') }),
      });
      $('modal-kyc').classList.add('hidden');
      toast('KYC submitted — under review', 'success');
      loadDashboard();
    } catch (err) { toast(err.message, 'error'); }
  }
});

// ---------- Deposit notifications (admin-credited) ----------
let lastDepositTxId = 0;

// Detect new deposit transactions and toast
function notifyDepositArrivals(transactions) {
  const deposits = transactions.filter(t => t.type === 'deposit');
  if (!deposits.length) return;
  const newest = deposits[0];
  if (lastDepositTxId === 0) { lastDepositTxId = newest.id; return; }
  const fresh = deposits.filter(t => t.id > lastDepositTxId);
  fresh.reverse().forEach(t => {
    toast(`Deposit received: +$${fmt(Math.abs(t.amount))}`, 'success');
  });
  lastDepositTxId = newest.id;
}

// ---------- USDT Wallet ----------
let usdtState = {
  balance: 0,
  usdBalance: 0,
  price: 1,
  address: '',
  lookupTimer: null,
  lastQrAddr: '',
};

function renderUsdt(user, priceObj) {
  const bal = Number(user.usdt_balance || 0);
  const usdBal = Number(user.balance || 0);
  const price = Number(priceObj?.price || 1);
  const source = priceObj?.source || 'fallback';
  usdtState.balance = bal;
  usdtState.usdBalance = usdBal;
  usdtState.price = price;
  usdtState.address = user.usdt_address || '';

  const usdEquiv = bal * price;
  $('stat-usdt').textContent = fmt6(bal);
  $('stat-usdt-usd').textContent = fmt(usdEquiv);
  $('stat-usdt-price').textContent = '$' + price.toFixed(4);

  $('usdt-balance-big').textContent = fmt6(bal);
  $('usdt-balance-usd').textContent = fmt(usdEquiv);
  $('usdt-usd-balance').textContent = fmt(usdBal);
  $('usdt-live-price').textContent = '$' + price.toFixed(4);
  $('usdt-price-source').textContent = source === 'coingecko' ? 'CoinGecko' : 'Cached';

  // Address card + QR
  const addr = user.usdt_address || '--';
  $('usdt-address').textContent = addr;
  if (addr && addr !== '--' && usdtState.lastQrAddr !== addr) {
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&margin=0&data=${encodeURIComponent(addr)}`;
    $('usdt-qr').src = qrUrl;
    usdtState.lastQrAddr = addr;
  }

  // Refresh tab previews
  recalcUsdtPreviews();
}

function recalcUsdtPreviews() {
  // Buy
  const buyInput = document.querySelector('.usdt-buy-usd');
  if (buyInput) {
    const usd = Number(buyInput.value) || 0;
    $('usdt-buy-pay').textContent = fmt(usd);
    $('usdt-buy-rate').textContent = usdtState.price.toFixed(4);
    $('usdt-buy-receive').textContent = fmt6(usd / Math.max(usdtState.price, 0.0001));
  }
  // Sell
  const sellInput = document.querySelector('.usdt-sell-usdt');
  if (sellInput) {
    const usdt = Number(sellInput.value) || 0;
    $('usdt-sell-sell').textContent = fmt6(usdt);
    $('usdt-sell-rate').textContent = usdtState.price.toFixed(4);
    $('usdt-sell-receive').textContent = fmt(usdt * usdtState.price);
  }
}

// Tab switching for USDT panel
document.querySelectorAll('.usdt-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.usdtTab;
    document.querySelectorAll('.usdt-tab').forEach(b => {
      if (b.dataset.usdtTab === tab) {
        b.classList.add('border-accent', 'text-accent');
        b.classList.remove('border-transparent', 'text-muted');
      } else {
        b.classList.remove('border-accent', 'text-accent');
        b.classList.add('border-transparent', 'text-muted');
      }
    });
    document.querySelectorAll('.usdt-pane').forEach(p => p.classList.add('hidden'));
    const target = $('usdt-pane-' + tab);
    if (target) target.classList.remove('hidden');
  });
});

// Live preview listeners
document.addEventListener('input', (e) => {
  if (!e.target) return;
  if (e.target.classList && (
    e.target.classList.contains('usdt-buy-usd') ||
    e.target.classList.contains('usdt-sell-usdt')
  )) {
    recalcUsdtPreviews();
  }
});

// Max buttons
document.addEventListener('click', (e) => {
  if (e.target && e.target.id === 'btn-usdt-sell-max') {
    const inp = document.querySelector('.usdt-sell-usdt');
    if (inp) { inp.value = usdtState.balance.toFixed(6); recalcUsdtPreviews(); }
  }
  if (e.target && e.target.id === 'btn-copy-usdt-addr') {
    if (!usdtState.address) return;
    navigator.clipboard.writeText(usdtState.address)
      .then(() => toast('USDT address copied', 'success'))
      .catch(() => toast('Copy failed', 'error'));
  }
});

// Form handlers
document.addEventListener('submit', async (e) => {
  if (e.target && e.target.id === 'form-usdt-buy') {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const data = await API.req('/api/usdt/buy', {
        method: 'POST',
        body: JSON.stringify({ usd_amount: Number(fd.get('usd_amount')) }),
      });
      e.target.reset();
      toast(`Bought ${fmt6(data.usdt_received)} USDT`, 'success');
      loadDashboard();
    } catch (err) { toast(err.message, 'error'); }
    return;
  }
  if (e.target && e.target.id === 'form-usdt-sell') {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const data = await API.req('/api/usdt/sell', {
        method: 'POST',
        body: JSON.stringify({ usdt_amount: Number(fd.get('usdt_amount')) }),
      });
      e.target.reset();
      toast(`Sold USDT · received $${fmt(data.usd_received)}`, 'success');
      loadDashboard();
    } catch (err) { toast(err.message, 'error'); }
    return;
  }
});

document.addEventListener('click', async (e) => {
  if (e.target && e.target.classList && e.target.classList.contains('btn-copy-text')) {
    const text = e.target.dataset.copy || '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      const original = e.target.textContent;
      e.target.textContent = 'Copied';
      setTimeout(() => { e.target.textContent = original; }, 1200);
      toast('Copied to clipboard', 'success');
    } catch { toast('Copy failed', 'error'); }
    return;
  }
});

// Copy referral
$('btn-copy-ref').addEventListener('click', async () => {
  const code = $('referral-code').textContent;
  try {
    await navigator.clipboard.writeText(code);
    toast('Code copied to clipboard', 'success');
  } catch {
    toast('Copy failed', 'error');
  }
});

// ---------- Admin ----------
async function loadAdmin() {
  try {
    const u = API.user();
    $('admin-name-pill').textContent = u.name;
    const [stats, users, txs] = await Promise.all([
      API.req('/api/admin/stats'),
      API.req('/api/admin/users'),
      API.req('/api/admin/transactions'),
    ]);
    $('admin-stat-users').textContent = stats.totalUsers;
    $('admin-stat-balance').textContent = fmt(stats.totalBalance);
    $('admin-stat-deposits').textContent = fmt(stats.totalDeposits);
    $('admin-stat-refbonus').textContent = fmt(stats.totalReferralBonus);
    $('admin-stat-credit').textContent = fmt(stats.totalAdminCredit);

    const ubody = $('tbody-admin-users');
    ubody.innerHTML = '';
    const nonAdmins = users.users.filter(x => !x.is_admin);
    if (nonAdmins.length === 0) {
      ubody.innerHTML = `<tr><td colspan="9" class="text-center text-muted py-8 text-sm">No users yet</td></tr>`;
    } else {
      nonAdmins.forEach(x => {
        const tr = document.createElement('tr');
        tr.className = 'border-t border-line hover:bg-bg/40';
        const usdtAddr = x.usdt_address || '';
        const usdtShort = usdtAddr ? usdtAddr.slice(0, 6) + '…' + usdtAddr.slice(-4) : '—';
        tr.innerHTML = `
          <td class="px-5 py-3 text-muted">#${x.id}</td>
          <td class="px-5 py-3">${escapeHtml(x.name)}</td>
          <td class="px-5 py-3 text-gray-300">${escapeHtml(x.email)}</td>
          <td class="px-5 py-3"><code class="text-xs text-accent">${x.referral_code}</code><div class="text-[10px] text-muted font-mono mt-0.5" title="${escapeHtml(usdtAddr)}">${usdtShort}</div></td>
          <td class="px-5 py-3 text-right">${x.referral_count}</td>
          <td class="px-5 py-3 text-right font-mono text-accent">$${fmt(x.balance)}</td>
          <td class="px-5 py-3 text-right font-mono text-yellow-400">${fmt6(x.usdt_balance || 0)}</td>
          <td class="px-5 py-3 text-muted text-xs">${fmtDate(x.created_at)}</td>
          <td class="px-5 py-3 pr-5 text-right whitespace-nowrap">
            <button data-id="${x.id}" data-label="${escapeHtml(x.email)}" class="btn-credit text-xs px-2.5 py-1.5 bg-accent/10 text-accent border border-accent/30 rounded hover:bg-accent/20 transition mr-1">+USD</button>
            <button data-id="${x.id}" data-label="${escapeHtml(x.email)}" class="btn-credit-usdt text-xs px-2.5 py-1.5 bg-yellow-400/10 text-yellow-400 border border-yellow-400/30 rounded hover:bg-yellow-400/20 transition mr-1">+USDT</button>
            <button data-id="${x.id}" data-label="${escapeHtml(x.email)}" class="btn-credit-bonus text-xs px-2.5 py-1.5 bg-purple-400/10 text-purple-400 border border-purple-400/30 rounded hover:bg-purple-400/20 transition">+Bonus</button>
          </td>
        `;
        ubody.appendChild(tr);
      });
      ubody.querySelectorAll('.btn-credit').forEach(b => {
        b.addEventListener('click', () => openCreditModal(b.dataset.id, b.dataset.label, 'usd'));
      });
      ubody.querySelectorAll('.btn-credit-usdt').forEach(b => {
        b.addEventListener('click', () => openCreditModal(b.dataset.id, b.dataset.label, 'usdt'));
      });
      ubody.querySelectorAll('.btn-credit-bonus').forEach(b => {
        b.addEventListener('click', () => openCreditModal(b.dataset.id, b.dataset.label, 'bonus'));
      });
    }

    const tbody = $('tbody-admin-tx');
    tbody.innerHTML = '';
    if (txs.transactions.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted py-8 text-sm">No transactions yet</td></tr>`;
    } else {
      txs.transactions.forEach(t => {
        const tt = txTypeLabel(t.type);
        const sign = t.amount >= 0 ? '+' : '';
        const tr = document.createElement('tr');
        tr.className = 'border-t border-line';
        tr.innerHTML = `
          <td class="px-5 py-3 text-muted text-xs">${fmtDate(t.created_at)}</td>
          <td class="px-5 py-3">${escapeHtml(t.name || '')} <span class="text-muted">${escapeHtml(t.email || '')}</span></td>
          <td class="px-5 py-3"><span class="${tt.cls}">${tt.label}</span></td>
          <td class="px-5 py-3 text-gray-400">${escapeHtml(t.note || '')}</td>
          <td class="px-5 py-3 pr-5 text-right font-mono ${t.amount >= 0 ? 'text-accent' : 'text-danger'}">${sign}$${fmt(Math.abs(t.amount))}</td>
        `;
        tbody.appendChild(tr);
      });
    }
  } catch (err) {
    toast(err.message, 'error');
    if (err.message.includes('unauthorized') || err.message.includes('forbidden')) logout();
  }
}

$('btn-refresh-admin').addEventListener('click', loadAdmin);

// ---------- Admin tabs ----------
let currentAdminTab = 'users';
let adminPollTimer = null;

function switchAdminTab(tab) {
  currentAdminTab = tab;
  document.querySelectorAll('.admin-tab').forEach(b => {
    if (b.dataset.adminTab === tab) {
      b.classList.add('border-accent', 'text-accent');
      b.classList.remove('border-transparent', 'text-muted');
    } else {
      b.classList.remove('border-accent', 'text-accent');
      b.classList.add('border-transparent', 'text-muted');
    }
  });
  $('admin-tab-users').classList.toggle('hidden', tab !== 'users');
  $('admin-tab-withdrawals').classList.toggle('hidden', tab !== 'withdrawals');
  const bkPane = $('admin-tab-backup');
  if (bkPane) bkPane.classList.toggle('hidden', tab !== 'backup');
  const kycPane = $('admin-tab-kyc');
  if (kycPane) kycPane.classList.toggle('hidden', tab !== 'kyc');
  if (tab === 'withdrawals') loadWithdrawals();
  if (tab === 'backup') loadBackups();
  if (tab === 'kyc') loadAdminKyc();
}

document.querySelectorAll('.admin-tab').forEach(b => {
  b.addEventListener('click', () => switchAdminTab(b.dataset.adminTab));
});

// ---------- Admin · Withdrawals ----------
async function loadWithdrawals() {
  try {
    const filter = ($('wd-filter') && $('wd-filter').value) || '';
    const url = filter ? `/api/admin/withdrawals?status=${encodeURIComponent(filter)}` : '/api/admin/withdrawals';
    const data = await API.req(url);
    $('wd-stat-pending').textContent = data.counts.pending || 0;
    $('wd-stat-success').textContent = data.counts.success || 0;
    $('wd-stat-rejected').textContent = data.counts.rejected || 0;
    $('wd-stat-total').textContent = data.counts.total || 0;

    const badge = $('wd-pending-badge');
    if (data.counts.pending > 0) {
      badge.classList.remove('hidden');
      badge.textContent = data.counts.pending;
    } else {
      badge.classList.add('hidden');
    }

    const body = $('tbody-withdrawals');
    body.innerHTML = '';
    if (!data.withdrawals.length) {
      body.innerHTML = `<tr><td colspan="7" class="text-center text-muted py-10 text-sm">No withdrawal requests${filter ? ` (${filter})` : ''}</td></tr>`;
      return;
    }
    data.withdrawals.forEach(w => {
      const amt = Math.abs(Number(w.amount));
      const wallet = w.wallet_address || '';
      const wShort = wallet ? wallet.slice(0, 8) + '…' + wallet.slice(-6) : '—';
      const txid = w.txid || '';
      const txShort = txid ? txid.slice(0, 8) + '…' + txid.slice(-4) : '—';
      const statusBadge = wdStatusBadge(w.status);

      const walletCell = wallet
        ? `<div class="flex items-center gap-1.5">
            <code class="text-[11px] text-gray-300" title="${escapeHtml(wallet)}">${wShort}</code>
            <button data-copy="${escapeHtml(wallet)}" class="btn-copy-text text-[10px] px-1.5 py-0.5 bg-accent/10 text-accent border border-accent/30 rounded hover:bg-accent/20 transition" title="Copy wallet address">Copy</button>
          </div>`
        : '<span class="text-muted">—</span>';

      const txidCell = txid
        ? `<div class="flex items-center gap-1.5">
            <code class="text-[11px] text-muted" title="${escapeHtml(txid)}">${txShort}</code>
            <button data-copy="${escapeHtml(txid)}" class="btn-copy-text text-[10px] px-1.5 py-0.5 bg-bg border border-line rounded hover:border-accent transition" title="Copy TXID">Copy</button>
          </div>`
        : '<span class="text-muted">—</span>';

      let actions = '';
      if (w.status === 'pending') {
        actions = `
          <button data-id="${w.id}" data-amount="${amt}" data-label="${escapeHtml(w.email)}" data-wallet="${escapeHtml(wallet)}" class="btn-wd-approve text-xs px-2.5 py-1.5 bg-accent/10 text-accent border border-accent/30 rounded hover:bg-accent/20 transition mr-1">Mark Success</button>
          <button data-id="${w.id}" data-amount="${amt}" data-label="${escapeHtml(w.email)}" class="btn-wd-reject text-xs px-2.5 py-1.5 bg-danger/10 text-danger border border-danger/30 rounded hover:bg-danger/20 transition">Reject</button>
        `;
      } else {
        actions = `<span class="text-xs text-muted">${w.processed_at ? fmtDate(w.processed_at) : '—'}</span>`;
      }
      const tr = document.createElement('tr');
      tr.className = 'border-t border-line hover:bg-bg/40';
      tr.innerHTML = `
        <td class="px-5 py-3 text-muted text-xs">${fmtDate(w.created_at)}</td>
        <td class="px-5 py-3"><div>${escapeHtml(w.name || '')}</div><div class="text-[11px] text-muted">${escapeHtml(w.email || '')}</div></td>
        <td class="px-5 py-3 text-right font-mono text-orange-400">$${fmt(amt)}</td>
        <td class="px-5 py-3">${walletCell}</td>
        <td class="px-5 py-3">${statusBadge}</td>
        <td class="px-5 py-3">${txidCell}</td>
        <td class="px-5 py-3 pr-5 text-right whitespace-nowrap">${actions}</td>
      `;
      body.appendChild(tr);
    });

    body.querySelectorAll('.btn-wd-approve').forEach(b => {
      b.addEventListener('click', () => openApproveModal(b.dataset.id, b.dataset.label, b.dataset.amount, b.dataset.wallet));
    });
    body.querySelectorAll('.btn-wd-reject').forEach(b => {
      b.addEventListener('click', () => openRejectModal(b.dataset.id, b.dataset.label, b.dataset.amount));
    });
  } catch (err) {
    toast(err.message, 'error');
  }
}

function wdStatusBadgeInline(status) {
  if (status === 'pending') return `<span class="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-yellow-500/10 text-yellow-400 ml-1">Pending</span>`;
  if (status === 'success') return `<span class="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-accent/10 text-accent ml-1">Success</span>`;
  if (status === 'rejected') return `<span class="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-danger/10 text-danger ml-1">Rejected</span>`;
  return '';
}

function wdStatusBadge(status) {
  if (status === 'pending') return `<span class="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">Pending</span>`;
  if (status === 'success') return `<span class="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-accent/10 text-accent border border-accent/30">Success</span>`;
  if (status === 'rejected') return `<span class="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-danger/10 text-danger border border-danger/30">Rejected</span>`;
  return `<span class="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-line text-muted">${escapeHtml(status || '')}</span>`;
}

if ($('btn-refresh-wd')) $('btn-refresh-wd').addEventListener('click', loadWithdrawals);
if ($('wd-filter')) $('wd-filter').addEventListener('change', loadWithdrawals);

// Approve modal
let currentApproveId = null;
let currentApproveWallet = '';
function openApproveModal(id, label, amount, wallet) {
  currentApproveId = id;
  currentApproveWallet = wallet || '';
  $('approve-wd-label').textContent = label;
  $('approve-wd-amount').textContent = fmt(amount);
  $('approve-wd-wallet').textContent = currentApproveWallet || '—';
  $('modal-approve-wd').classList.remove('hidden');
  $('form-approve-wd').reset();
}
$('btn-approve-wd-cancel').addEventListener('click', () => $('modal-approve-wd').classList.add('hidden'));
$('btn-approve-wd-copy').addEventListener('click', async () => {
  if (!currentApproveWallet) return;
  try {
    await navigator.clipboard.writeText(currentApproveWallet);
    const btn = $('btn-approve-wd-copy');
    const orig = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = orig; }, 1200);
    toast('Wallet copied', 'success');
  } catch { toast('Copy failed', 'error'); }
});
$('form-approve-wd').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentApproveId) return;
  const fd = new FormData(e.target);
  try {
    await API.req(`/api/admin/withdrawals/${currentApproveId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ txid: fd.get('txid') || undefined }),
    });
    $('modal-approve-wd').classList.add('hidden');
    toast('Marked as success', 'success');
    loadWithdrawals();
  } catch (err) { toast(err.message, 'error'); }
});

// Reject modal
let currentRejectId = null;
function openRejectModal(id, label, amount) {
  currentRejectId = id;
  $('reject-wd-label').textContent = label;
  $('reject-wd-amount').textContent = fmt(amount);
  $('modal-reject-wd').classList.remove('hidden');
  $('form-reject-wd').reset();
}
$('btn-reject-wd-cancel').addEventListener('click', () => $('modal-reject-wd').classList.add('hidden'));
$('form-reject-wd').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentRejectId) return;
  const fd = new FormData(e.target);
  try {
    await API.req(`/api/admin/withdrawals/${currentRejectId}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason: fd.get('reason') || undefined }),
    });
    $('modal-reject-wd').classList.add('hidden');
    toast('Rejected & refunded', 'success');
    loadWithdrawals();
  } catch (err) { toast(err.message, 'error'); }
});

// Create user
$('form-create-user').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await API.req('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        name: fd.get('name'),
        email: fd.get('email'),
        password: fd.get('password'),
      }),
    });
    e.target.reset();
    toast('User created', 'success');
    loadAdmin();
  } catch (err) {
    toast(err.message, 'error');
  }
});

// Credit modal — supports 'usd' or 'usdt' modes
let currentCreditUserId = null;
let currentCreditMode = 'usd';
function openCreditModal(id, label, mode = 'usd') {
  currentCreditUserId = id;
  currentCreditMode = mode;
  $('credit-user-label').textContent = label;
  $('modal-credit').classList.remove('hidden');
  $('form-credit').reset();
  const title = $('modal-credit').querySelector('h3');
  const amtInput = $('form-credit').querySelector('input[name="amount"]');
  if (mode === 'usdt') {
    if (title) title.textContent = 'Add USDT to Wallet';
    if (amtInput) { amtInput.placeholder = 'Amount in USDT (e.g. 100.000000)'; amtInput.step = '0.000001'; }
  } else if (mode === 'bonus') {
    if (title) title.textContent = 'Add Joining Bonus';
    if (amtInput) { amtInput.placeholder = 'Amount in USD (joining-bonus wallet)'; amtInput.step = '0.01'; }
  } else {
    if (title) title.textContent = 'Add USD Credit';
    if (amtInput) { amtInput.placeholder = 'Amount in USD'; amtInput.step = '0.01'; }
  }
  const txInput = $('credit-txid-input');
  if (txInput) txInput.classList.add('hidden');
}
$('btn-credit-cancel').addEventListener('click', () => {
  $('modal-credit').classList.add('hidden');
});
$('form-credit').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentCreditUserId) return;
  const fd = new FormData(e.target);
  try {
    const path = currentCreditMode === 'usdt'  ? `/api/admin/users/${currentCreditUserId}/credit-usdt`
               : currentCreditMode === 'bonus' ? `/api/admin/users/${currentCreditUserId}/credit-bonus`
               :                                 `/api/admin/users/${currentCreditUserId}/credit`;
    await API.req(path, {
      method: 'POST',
      body: JSON.stringify({
        amount: Number(fd.get('amount')),
        note: fd.get('note') || undefined,
      }),
    });
    $('modal-credit').classList.add('hidden');
    const msg = { usdt: 'USDT wallet credited', bonus: 'Joining-bonus wallet credited' }[currentCreditMode] || 'USD balance updated';
    toast(msg, 'success');
    loadAdmin();
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ---------- Admin · Backup & Migration ----------
function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

async function loadBackups() {
  try {
    const data = await API.req('/api/admin/backup/list');
    $('bk-db-size').textContent = fmtBytes(data.db_size);
    $('bk-db-path').textContent = data.db_path || '—';
    $('bk-dir').textContent = data.backup_dir || '—';
    $('bk-retention').textContent = data.retention || 7;
    $('bk-count').textContent = data.snapshots.length;
    const pendingEl = $('bk-pending');
    if (data.pending_restore) {
      pendingEl.textContent = 'Staged';
      pendingEl.className = 'text-2xl font-bold text-yellow-400';
    } else {
      pendingEl.textContent = 'None';
      pendingEl.className = 'text-2xl font-bold text-gray-300';
    }
    const tbody = $('tbody-bk-snaps');
    tbody.innerHTML = '';
    if (!data.snapshots.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="text-center text-muted py-8 text-sm">No snapshots yet — click "Snapshot to volume" to create one.</td></tr>`;
      return;
    }
    data.snapshots.forEach(s => {
      const tr = document.createElement('tr');
      tr.className = 'border-t border-line hover:bg-bg/40';
      tr.innerHTML = `
        <td class="px-5 py-3 font-mono text-xs text-gray-300 break-all">${escapeHtml(s.name)}</td>
        <td class="px-5 py-3 text-right font-mono text-accent">${fmtBytes(s.size)}</td>
        <td class="px-5 py-3 text-muted text-xs">${fmtDate(s.mtime.replace('T', ' ').slice(0, 19))}</td>
        <td class="px-5 py-3 pr-5 text-right whitespace-nowrap">
          <button data-name="${escapeHtml(s.name)}" class="btn-bk-del text-xs px-2.5 py-1.5 bg-danger/10 text-danger border border-danger/30 rounded hover:bg-danger/20 transition">Delete</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll('.btn-bk-del').forEach(b => {
      b.addEventListener('click', async () => {
        if (!confirm(`Delete snapshot ${b.dataset.name}? This can't be undone.`)) return;
        try {
          await API.req('/api/admin/backup/' + encodeURIComponent(b.dataset.name), { method: 'DELETE' });
          toast('Snapshot deleted', 'success');
          loadBackups();
        } catch (err) { toast(err.message, 'error'); }
      });
    });
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function downloadBackup() {
  try {
    const t = API.token();
    const res = await fetch('/api/admin/backup/download', { headers: { Authorization: 'Bearer ' + t } });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'download failed');
    }
    const blob = await res.blob();
    const cd = res.headers.get('content-disposition') || '';
    const m = cd.match(/filename="([^"]+)"/);
    const name = m ? m[1] : `quantedge-backup-${Date.now()}.db`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
    toast('Backup downloaded', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function snapshotNow() {
  try {
    const data = await API.req('/api/admin/backup/snapshot', { method: 'POST' });
    toast(`Snapshot saved: ${data.name}`, 'success');
    loadBackups();
  } catch (err) { toast(err.message, 'error'); }
}

async function uploadRestore(file) {
  const t = API.token();
  const buf = await file.arrayBuffer();
  const res = await fetch('/api/admin/backup/restore', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + t,
      'Content-Type': 'application/octet-stream',
    },
    body: buf,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'upload failed');
  return data;
}

// Wire backup buttons (delegated so they work after DOM is built)
document.addEventListener('click', (e) => {
  if (!e.target) return;
  if (e.target.id === 'btn-bk-download') downloadBackup();
  if (e.target.id === 'btn-bk-snapshot') snapshotNow();
  if (e.target.id === 'btn-bk-refresh') loadBackups();
});

document.addEventListener('change', (e) => {
  if (e.target && e.target.id === 'bk-confirm') {
    const btn = $('btn-bk-restore');
    if (btn) btn.disabled = !e.target.checked;
  }
});

document.addEventListener('submit', async (e) => {
  if (e.target && e.target.id === 'form-bk-restore') {
    e.preventDefault();
    const file = $('bk-file').files[0];
    if (!file) return toast('Pick a .db file first', 'error');
    if (!$('bk-confirm').checked) return toast('Confirm the warning checkbox first', 'error');
    try {
      const data = await uploadRestore(file);
      const result = $('bk-restore-result');
      result.classList.remove('hidden');
      result.textContent = `✓ Staged ${fmtBytes(data.size)} — restart the server to apply.`;
      toast('Restore staged · restart to apply', 'success');
      loadBackups();
    } catch (err) {
      toast(err.message, 'error');
    }
  }
});

// ---------- Admin · KYC Reviews ----------
function kycStatusBadge(s) {
  if (s === 'pending')  return `<span class="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-yellow-400/10 text-yellow-400 border border-yellow-400/30">Pending</span>`;
  if (s === 'approved') return `<span class="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-accent/10 text-accent border border-accent/30">Approved</span>`;
  if (s === 'rejected') return `<span class="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-danger/10 text-danger border border-danger/30">Rejected</span>`;
  return `<span class="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-line text-muted">—</span>`;
}

async function loadAdminKyc() {
  try {
    const filter = ($('kyc-filter') && $('kyc-filter').value) || '';
    const url = filter ? `/api/admin/kyc?status=${encodeURIComponent(filter)}` : '/api/admin/kyc';
    const data = await API.req(url);
    $('kyc-stat-pending').textContent = data.counts.pending || 0;
    $('kyc-stat-approved').textContent = data.counts.approved || 0;
    $('kyc-stat-rejected').textContent = data.counts.rejected || 0;
    $('kyc-stat-notsub').textContent = data.counts.not_submitted || 0;

    const badge = $('kyc-pending-badge');
    if (data.counts.pending > 0) {
      badge.classList.remove('hidden');
      badge.textContent = data.counts.pending;
    } else {
      badge.classList.add('hidden');
    }

    const tbody = $('tbody-kyc');
    tbody.innerHTML = '';
    if (!data.kyc.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted py-10 text-sm">No KYC submissions${filter ? ` (${filter})` : ''}</td></tr>`;
      return;
    }
    data.kyc.forEach(k => {
      const tr = document.createElement('tr');
      tr.className = 'border-t border-line hover:bg-bg/40';
      tr.innerHTML = `
        <td class="px-5 py-3 text-muted text-xs">${k.kyc_submitted_at ? fmtDate(k.kyc_submitted_at) : '—'}</td>
        <td class="px-5 py-3"><div>${escapeHtml(k.name)}</div><div class="text-[11px] text-muted">${escapeHtml(k.email)}</div></td>
        <td class="px-5 py-3 font-mono text-xs">${escapeHtml(k.mobile_number || '—')}</td>
        <td class="px-5 py-3">${kycStatusBadge(k.kyc_status)}</td>
        <td class="px-5 py-3 pr-5 text-right">
          <button data-id="${k.id}" class="btn-kyc-view text-xs px-2.5 py-1.5 bg-accent2/10 text-accent2 border border-accent2/30 rounded hover:bg-accent2/20 transition">View</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll('.btn-kyc-view').forEach(b => {
      b.addEventListener('click', () => openKycReview(b.dataset.id));
    });
  } catch (err) { toast(err.message, 'error'); }
}

let currentKycUserId = null;
async function openKycReview(id) {
  try {
    const d = await API.req('/api/admin/kyc/' + id);
    currentKycUserId = id;
    $('kyc-admin-status').innerHTML = kycStatusBadge(d.user.kyc_status);
    $('kyc-admin-name').textContent = d.user.name || '—';
    $('kyc-admin-email').textContent = d.user.email || '—';
    $('kyc-admin-mobile').textContent = d.user.mobile_number || '—';
    $('kyc-admin-submitted').textContent = d.user.kyc_submitted_at ? fmtDate(d.user.kyc_submitted_at) : '—';
    $('kyc-admin-aadhar').src = d.aadhar || '';
    $('kyc-admin-pan').src = d.pan || '';
    $('kyc-admin-selfie').src = d.selfie || '';
    $('form-kyc-action').reset();
    const isPending = d.user.kyc_status === 'pending';
    $('btn-kyc-admin-approve').disabled = !isPending;
    $('btn-kyc-admin-reject').disabled = !isPending;
    $('btn-kyc-admin-approve').className = isPending
      ? 'flex-1 bg-accent hover:bg-accent/90 text-bg font-semibold py-2.5 rounded-lg text-sm'
      : 'flex-1 bg-line text-muted font-semibold py-2.5 rounded-lg text-sm cursor-not-allowed';
    $('btn-kyc-admin-reject').className = isPending
      ? 'flex-1 bg-danger hover:bg-danger/90 text-white font-semibold py-2.5 rounded-lg text-sm'
      : 'flex-1 bg-line text-muted font-semibold py-2.5 rounded-lg text-sm cursor-not-allowed';
    $('modal-kyc-admin').classList.remove('hidden');
  } catch (err) { toast(err.message, 'error'); }
}

document.addEventListener('click', async (e) => {
  if (!e.target) return;
  if (e.target.id === 'btn-kyc-admin-cancel') $('modal-kyc-admin').classList.add('hidden');
  if (e.target.id === 'btn-kyc-admin-approve') {
    if (!currentKycUserId) return;
    try {
      await API.req(`/api/admin/kyc/${currentKycUserId}/approve`, { method: 'POST' });
      $('modal-kyc-admin').classList.add('hidden');
      toast('KYC approved', 'success');
      loadAdminKyc();
    } catch (err) { toast(err.message, 'error'); }
  }
  if (e.target.id === 'btn-kyc-admin-reject') {
    if (!currentKycUserId) return;
    const reason = $('form-kyc-action').querySelector('input[name="reason"]').value || undefined;
    try {
      await API.req(`/api/admin/kyc/${currentKycUserId}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
      $('modal-kyc-admin').classList.add('hidden');
      toast('KYC rejected', 'success');
      loadAdminKyc();
    } catch (err) { toast(err.message, 'error'); }
  }
  if (e.target.id === 'btn-refresh-kyc') loadAdminKyc();
});

document.addEventListener('change', (e) => {
  if (e.target && e.target.id === 'kyc-filter') loadAdminKyc();
});

// ---------- Util ----------
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------- Boot ----------
(function init() {
  const u = API.user();
  if (u && API.token()) {
    routeAfterAuth();
  } else {
    show('view-auth');
  }
})();
