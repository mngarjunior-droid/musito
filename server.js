const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

process.on('uncaughtException', (err) => {
  console.error('ERROR CAPTURADO EN PROCESO:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('RECHAZO NO CONTROLADO:', reason);
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const publicDir = fs.existsSync(path.join(__dirname, 'public')) ? path.join(__dirname, 'public') : __dirname;
const cartasDir = path.join(publicDir, 'cartas');
if (!fs.existsSync(cartasDir)) {
  try { fs.mkdirSync(cartasDir, { recursive: true }); } catch (e) {}
}
app.use(express.static(publicDir));

app.get('/api/cartas-info', (req, res) => {
  let archivos = [];
  let prefix = '/cartas/';

  const esArchivoValido = (f) => {
    const lower = f.toLowerCase();
    const esImg = lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.webp');
    if (!esImg || f.startsWith('.')) return false;
    return lower.startsWith('carta') || lower.includes('tapa') || lower.includes('fondo') || lower.includes('blanco') || lower.includes('reverso') || lower.includes('dorso') || lower.includes('oros') || lower.includes('copas') || lower.includes('espadas') || lower.includes('bastos');
  };

  // 1. Revisar si hay cartas en public/cartas/
  if (fs.existsSync(cartasDir)) {
    const listCartas = fs.readdirSync(cartasDir).filter(esArchivoValido);
    if (listCartas.length > 0) {
      listCartas.forEach(f => archivos.push({ nombre: f, url: `/cartas/${f}` }));
    }
  }

  // 2. Revisar si hay cartas directamente en public/
  if (fs.existsSync(publicDir)) {
    const listPub = fs.readdirSync(publicDir).filter(esArchivoValido);
    if (listPub.length > 0) {
      listPub.forEach(f => {
        // Evitar duplicados si ya estaba en cartas/
        if (!archivos.some(a => a.nombre === f)) {
          archivos.push({ nombre: f, url: `/${f}` });
        }
      });
    }
  }

  const nombresSimples = archivos.map(a => a.nombre);
  return res.json({ 
    existe: archivos.length > 0, 
    total: archivos.length, 
    prefix: archivos.length > 0 ? archivos[0].url.substring(0, archivos[0].url.lastIndexOf('/') + 1) : '/cartas/', 
    archivos: nombresSimples,
    detalles: archivos 
  });
});

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

// ===== PERSISTENCIA Y REGISTRO DE CLASIFICACIÓN / LEADERBOARD =====
const LEADERBOARD_FILE = path.join(__dirname, 'leaderboard.json');
let leaderboard = {};

function cargarLeaderboard() {
  try {
    if (fs.existsSync(LEADERBOARD_FILE)) {
      const data = JSON.parse(fs.readFileSync(LEADERBOARD_FILE, 'utf8'));
      if (data && typeof data === 'object') leaderboard = data;
    }
  } catch (e) {
    console.error("Error al cargar leaderboard:", e);
  }
}

function guardarLeaderboard() {
  try {
    fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(leaderboard, null, 2), 'utf8');
  } catch (e) {
    console.error("Error al guardar leaderboard:", e);
  }
}
cargarLeaderboard();

function actualizarJugadorEnLeaderboard(token, nombre, avatar) {
  if (!token) return;
  if (!leaderboard[token]) {
    leaderboard[token] = {
      token: token,
      nombre: nombre || 'Jugador',
      avatar: avatar || '👑',
      vacas: 0,
      chicos: 0,
      ordagos: 0,
      partidas: 0,
      ultimaConexion: Date.now()
    };
  } else {
    if (nombre && typeof nombre === 'string') leaderboard[token].nombre = nombre;
    if (avatar && typeof avatar === 'string') leaderboard[token].avatar = avatar;
    leaderboard[token].ultimaConexion = Date.now();
  }
  guardarLeaderboard();
}

function registrarVictoriaLeaderboard(token, nombre, avatar, tipo) {
  if (!token) return;
  actualizarJugadorEnLeaderboard(token, nombre, avatar);
  const entrada = leaderboard[token];
  if (!entrada) return;

  if (tipo !== 'ordago') {
    entrada.partidas = (entrada.partidas || 0) + 1;
  }
  if (tipo === 'vaca') {
    entrada.vacas = (entrada.vacas || 0) + 1;
    entrada.chicos = (entrada.chicos || 0) + 1;
  } else if (tipo === 'chico') {
    entrada.chicos = (entrada.chicos || 0) + 1;
  } else if (tipo === 'ordago') {
    entrada.ordagos = (entrada.ordagos || 0) + 1;
  }
  guardarLeaderboard();
  io.emit('leaderboardActualizado', obtenerListaLeaderboard());
}

function obtenerListaLeaderboard() {
  const lista = Object.values(leaderboard).map(item => {
    const partidas = item.partidas || 0;
    const chicos = item.chicos || 0;
    const winrate = partidas > 0 ? Math.round((chicos / partidas) * 100) : 0;
    return {
      token: item.token,
      nombre: item.nombre || 'Jugador',
      avatar: item.avatar || '👑',
      vacas: item.vacas || 0,
      chicos: item.chicos || 0,
      ordagos: item.ordagos || 0,
      partidas: partidas,
      winrate: winrate,
      ultimaConexion: item.ultimaConexion || Date.now()
    };
  });

  lista.sort((a, b) => {
    if (b.vacas !== a.vacas) return b.vacas - a.vacas;
    if (b.chicos !== a.chicos) return b.chicos - a.chicos;
    if (b.ordagos !== a.ordagos) return b.ordagos - a.ordagos;
    if (b.winrate !== a.winrate) return b.winrate - a.winrate;
    return b.partidas - a.partidas;
  });

  return lista;
}

const ASIENTOS_INFO = [
  { id: 0, nombreDef: "Asiento 1", rol: "Mano", pareja: 0 },
  { id: 1, nombreDef: "Asiento 2", rol: "Segundo", pareja: 1 },
  { id: 2, nombreDef: "Asiento 3", rol: "Tercero", pareja: 0 },
  { id: 3, nombreDef: "Asiento 4", rol: "Postre", pareja: 1 }
];

const salas = {};

function obtenerNombrePareja(sala, parejaIdx) {
  if (sala && sala.nombresParejas && sala.nombresParejas[parejaIdx]) {
    return sala.nombresParejas[parejaIdx];
  }
  return `Pareja ${parseInt(parejaIdx) + 1}`;
}

function obtenerOCrearSala(idSala) {
  const sId = (idSala && idSala.trim() !== "") ? idSala.trim().toLowerCase() : "principal";
  if (!salas[sId]) {
    salas[sId] = {
      id: sId,
      jugadoresPorToken: {},
      nombresParejas: { 0: 'Pareja 1', 1: 'Pareja 2' },
      enPartida: false,
      modoLoco: false,
      indicesCartaRevelada: { 0: null, 1: null, 2: null, 3: null },
      mazo: [],
      descartes: [],
      manos: { 0: [], 1: [], 2: [], 3: [] },
      puntos: { 0: 0, 1: 0 },
      chicosGanados: { 0: 0, 1: 0 },
      vacasGanadas: { 0: 0, 1: 0 },
      fase: 'espera',
      asientoMano: 0,
      turno: 0,
      ordenMusVotos: {},
      declaraciones: { pares: {}, juego: {} },
      apuestaActual: { total: 0, ultimoAumento: 0, ultimoApostador: null, ordago: false, enPaso: true },
      decisionPareja: { activa: false, parejaVotante: null, votos: {}, tiempoRestante: 12, timerId: null },
      apuestasLances: {
        grande: { querido: false, puntos: 1, ordago: false, resueltoEnFalso: false },
        chica: { querido: false, puntos: 1, ordago: false, resueltoEnFalso: false },
        pares: { querido: false, puntos: 1, ordago: false, resueltoEnFalso: false, hayPares: false },
        juego: { querido: false, puntos: 1, ordago: false, resueltoEnFalso: false, esAlPunto: false }
      },
      pasosEnLance: 0,
      recuentoEnCurso: false,
      timersGenerales: [],
      botTurnoTimer: null,
      botDecisionTimers: []
    };
  }
  return salas[sId];
}

function programarTimerSala(sala, fn, delayMs) {
  if (!Array.isArray(sala.timersGenerales)) sala.timersGenerales = [];
  const t = setTimeout(() => {
    if (Array.isArray(sala.timersGenerales)) {
      sala.timersGenerales = sala.timersGenerales.filter(item => item !== t);
    }
    fn();
  }, delayMs);
  sala.timersGenerales.push(t);
  return t;
}

function limpiarTodosLosTimers(sala) {
  limpiarTimersBots(sala);
  limpiarTimerDecision(sala);
  if (Array.isArray(sala.timersGenerales)) {
    sala.timersGenerales.forEach(t => clearTimeout(t));
    sala.timersGenerales = [];
  }
}

function limpiarTimersBots(sala) {
  if (sala.botTurnoTimer) {
    clearTimeout(sala.botTurnoTimer);
    sala.botTurnoTimer = null;
  }
  if (Array.isArray(sala.botDecisionTimers)) {
    sala.botDecisionTimers.forEach(t => clearTimeout(t));
    sala.botDecisionTimers = [];
  }
}

function crearMazo() {
  const palos = ['oros', 'copas', 'espadas', 'bastos'];
  const valores = [1, 2, 3, 4, 5, 6, 7, 10, 11, 12];
  let m = [];
  for (let p of palos) {
    for (let v of valores) {
      m.push({
        palo: p,
        numero: v.toString(),
        valorMus: (v === 3) ? 12 : (v === 2 ? 1 : v),
        valorJuego: (v >= 10 || v === 3) ? 10 : (v === 2 || v === 1 ? 1 : v)
      });
    }
  }
  for (let i = m.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [m[i], m[j]] = [m[j], m[i]];
  }
  return m;
}

function robarCarta(sala) {
  if (!sala.mazo || sala.mazo.length === 0) {
    if (sala.descartes && sala.descartes.length > 0) {
      sala.mazo = [...sala.descartes];
      sala.descartes = [];
      for (let i = sala.mazo.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [sala.mazo[i], sala.mazo[j]] = [sala.mazo[j], sala.mazo[i]];
      }
    } else {
      sala.mazo = crearMazo();
    }
  }
  return sala.mazo.pop() || { palo: 'oros', numero: '1', valorMus: 1, valorJuego: 1 };
}

function distanciaMano(asiento, asientoMano) {
  return (asiento - asientoMano + 4) % 4;
}

function tieneManoRelativa(asiento, sala) {
  const miPareja = ASIENTOS_INFO[asiento].pareja;
  const rival1 = miPareja === 0 ? 1 : 0;
  const rival2 = miPareja === 0 ? 3 : 2;
  const distMia = distanciaMano(asiento, sala.asientoMano);
  const distRival1 = distanciaMano(rival1, sala.asientoMano);
  const distRival2 = distanciaMano(rival2, sala.asientoMano);
  return distMia < Math.min(distRival1, distRival2);
}

function compararManosGrande(manoA, manoB) {
  if (!manoA || !Array.isArray(manoA)) return -1;
  if (!manoB || !Array.isArray(manoB)) return 1;
  const vA = manoA.map(c => (c && c.valorMus !== undefined ? c.valorMus : 0)).sort((a,b) => b - a);
  const vB = manoB.map(c => (c && c.valorMus !== undefined ? c.valorMus : 0)).sort((a,b) => b - a);
  for (let i = 0; i < 4; i++) {
    let valA = vA[i] || 0;
    let valB = vB[i] || 0;
    if (valA > valB) return 1;
    if (valA < valB) return -1;
  }
  return 0;
}

function compararManosChica(manoA, manoB) {
  if (!manoA || !Array.isArray(manoA)) return -1;
  if (!manoB || !Array.isArray(manoB)) return 1;
  const vA = manoA.map(c => (c && c.valorMus !== undefined ? c.valorMus : 99)).sort((a,b) => a - b);
  const vB = manoB.map(c => (c && c.valorMus !== undefined ? c.valorMus : 99)).sort((a,b) => a - b);
  for (let i = 0; i < 4; i++) {
    let valA = vA[i] || 99;
    let valB = vB[i] || 99;
    if (valA < valB) return 1;
    if (valA > valB) return -1;
  }
  return 0;
}

function nombreCartaMus(val) {
  if (val === 12) return "Rey";
  if (val === 11) return "Caballo";
  if (val === 10) return "Sota";
  if (val === 1) return "As";
  return val ? val.toString() : "-";
}

function formatearCartasMus(mano, orden = 'desc') {
  if (!mano || !Array.isArray(mano)) return "";
  const vals = mano.map(c => (c && c.valorMus ? c.valorMus : 0));
  if (orden === 'asc') vals.sort((a,b) => a - b);
  else vals.sort((a,b) => b - a);
  return vals.map(v => nombreCartaMus(v)).join('-');
}

function evaluarDetallePares(m) {
  if (!m || !Array.isArray(m)) return { tipo: 0, nombre: "Sin pares", val1: 0, val2: 0, cobro: 0, desc: "Sin pares" };
  let cnt = {};
  m.forEach(c => {
    if (c && c.valorMus !== undefined) {
      cnt[c.valorMus] = (cnt[c.valorMus] || 0) + 1;
    }
  });
  let parejas = Object.keys(cnt).filter(k => cnt[k] >= 2).map(Number).sort((a,b) => b - a);
  let maxRep = Math.max(0, ...Object.values(cnt));

  if (maxRep === 4) {
    let val = parejas[0] || 0;
    return { tipo: 4, nombre: "Cuarteto", val1: val, val2: 0, cobro: 3, desc: `Cuarteto de ${nombreCartaMus(val)}` };
  }
  if (parejas.length === 2) {
    return { tipo: 3, nombre: "Duples", val1: parejas[0], val2: parejas[1], cobro: 3, desc: `Duples de ${nombreCartaMus(parejas[0])} y ${nombreCartaMus(parejas[1])}` };
  }
  if (maxRep === 3) {
    return { tipo: 2, nombre: "Medias", val1: parejas[0], val2: 0, cobro: 2, desc: `Medias de ${nombreCartaMus(parejas[0])}` };
  }
  if (parejas.length === 1) {
    return { tipo: 1, nombre: "Pareja", val1: parejas[0], val2: 0, cobro: 1, desc: `Pareja de ${nombreCartaMus(parejas[0])}` };
  }
  return { tipo: 0, nombre: "Sin pares", val1: 0, val2: 0, cobro: 0, desc: "Sin pares" };
}

function compararManosPares(pA, pB) {
  if (pA.tipo > pB.tipo) return 1;
  if (pA.tipo < pB.tipo) return -1;
  if (pA.tipo === 0) return 0;
  if (pA.val1 > pB.val1) return 1;
  if (pA.val1 < pB.val1) return -1;
  if (pA.val2 > pB.val2) return 1;
  if (pA.val2 < pB.val2) return -1;
  return 0;
}

const JERARQUIA_JUEGO = { 31: 8, 32: 7, 40: 6, 37: 5, 36: 4, 35: 3, 34: 2, 33: 1 };

function evaluarDetalleJuego(m) {
  if (!m || !Array.isArray(m)) return { tiene: false, valor: 0, rangoJuego: 0, cobro: 1, desc: "Punto (0)", esLaReal: false };
  let s = m.reduce((acc, c) => acc + (c && c.valorJuego ? c.valorJuego : 0), 0);
  if (s >= 31) {
    let nums = m.map(c => (c && c.numero !== undefined) ? parseInt(c.numero) : 0);
    let sietes = nums.filter(n => n === 7).length;
    let sotas = nums.filter(n => n === 10).length;
    let esLaReal = (s === 31 && sietes === 3 && sotas === 1);
    let rango = esLaReal ? 9 : (JERARQUIA_JUEGO[s] || 1);
    let cobro = (s === 31) ? 3 : 2;
    let desc = esLaReal ? "👑 ¡La Real! (31 Invencible)" : ((s === 31) ? "La una (31)" : `Juego de ${s}`);
    return { tiene: true, valor: s, rangoJuego: rango, cobro: cobro, desc: desc, esLaReal: esLaReal };
  }
  return { tiene: false, valor: s, rangoJuego: 0, cobro: 1, desc: `Punto (${s})`, esLaReal: false };
}

function detectarJugadaEspecial(m) {
  if (!m || !Array.isArray(m) || m.length < 4) return null;
  const nums = m.map(c => (c && c.numero !== undefined) ? parseInt(c.numero) : 0);
  const valsMus = m.map(c => (c && c.valorMus !== undefined) ? c.valorMus : 0).sort((a,b) => b - a);

  // 1. La Real: Tres sietes y una Sota (31)
  const sietes = nums.filter(n => n === 7).length;
  const sotas = nums.filter(n => n === 10).length;
  if (sietes === 3 && sotas === 1) {
    return {
      clave: 'la_real',
      nombre: '👑 ¡LA REAL!',
      desc: 'Tres Sietes y una Sota (31 Invencible)',
      badge: '👑 LA REAL',
      tipo: 'legendaria'
    };
  }

  // 2. Cuarteto de Reyes (4 Reyes o Treses con valorMus 12)
  const reyes = valsMus.filter(v => v === 12).length;
  if (reyes === 4) {
    return {
      clave: 'cuatro_reyes',
      nombre: '🦁 CUARTETO DE REYES',
      desc: '4 Reyes (Imbatible a Grande)',
      badge: '🦁 4 REYES',
      tipo: 'epica'
    };
  }

  // 3. El Solomillo (Duples de 2 Reyes y 2 Ases)
  const ases = valsMus.filter(v => v === 1).length;
  if (reyes === 2 && ases === 2) {
    return {
      clave: 'solomillo',
      nombre: '🥩 EL SOLOMILLO',
      desc: 'Duples de Reyes y Ases',
      badge: '🥩 SOLOMILLO',
      tipo: 'epica'
    };
  }

  // 4. Cuarteto de Ases (4 Ases o Doses con valorMus 1)
  if (ases === 4) {
    return {
      clave: 'cuatro_ases',
      nombre: '🎯 CUARTETO DE ASES',
      desc: '4 Ases (Imbatible a Chica)',
      badge: '🎯 4 ASES',
      tipo: 'epica'
    };
  }

  // 5. La 31 (La una: tres figuras y un as)
  const figuras = nums.filter(n => n >= 10 || n === 3).length;
  if (sietes !== 3 && figuras === 3 && ases === 1) {
    return {
      clave: 'la_una',
      nombre: '💎 LA UNA (31)',
      desc: '3 Figuras y un As',
      badge: '💎 31 (LA UNA)',
      tipo: 'destacada'
    };
  }

  return null;
}

function compararManosJuego(jA, jB) {
  if (jA.tiene && !jB.tiene) return 1;
  if (!jA.tiene && jB.tiene) return -1;
  if (jA.tiene && jB.tiene) {
    if (jA.rangoJuego > jB.rangoJuego) return 1;
    if (jA.rangoJuego < jB.rangoJuego) return -1;
    return 0;
  }
  if (jA.valor > jB.valor) return 1;
  if (jA.valor < jB.valor) return -1;
  return 0;
}

function evaluarFuerzaGrande(mano) {
  if (!mano || !Array.isArray(mano)) return 0;
  const vals = mano.map(c => (c && c.valorMus ? c.valorMus : 0)).sort((a,b) => b - a);
  const reyes = vals.filter(v => v === 12).length;
  if (reyes === 4) return 100;
  if (reyes === 3) return 96;
  if (reyes === 2 && vals[2] >= 11) return 84; // 2 Reyes + Caballo
  if (reyes === 2 && vals[2] >= 10) return 78; // 2 Reyes + Sota
  if (reyes === 2) return 72; // 2 Reyes
  if (reyes === 1 && vals[1] >= 11 && vals[2] >= 10) return 60; // 1 Rey + Caballo + Sota
  if (reyes === 1 && vals[1] >= 11) return 52; // 1 Rey + Caballo
  if (reyes === 1 && vals[1] >= 10) return 46; // 1 Rey + Sota
  if (reyes === 1) return 40; // 1 Rey
  if (vals[0] >= 11 && vals[1] >= 10) return 28; // Caballo + Sota
  if (vals[0] >= 11) return 20; // Caballo alto
  return 10;
}

function evaluarFuerzaChica(mano) {
  if (!mano || !Array.isArray(mano)) return 0;
  const vals = mano.map(c => (c && c.valorMus ? c.valorMus : 0)).sort((a,b) => a - b);
  const ases = vals.filter(v => v === 1).length;
  if (ases === 4) return 100;
  if (ases === 3) return 96;
  if (ases === 2 && vals[2] <= 4) return 82; // 2 Ases + 4
  if (ases === 2 && vals[2] <= 5) return 75; // 2 Ases + 5
  if (ases === 2) return 68; // 2 Ases
  if (ases === 1 && vals[1] <= 4 && vals[2] <= 5) return 58; // 1 As + 4 + 5
  if (ases === 1 && vals[1] <= 4) return 50; // 1 As + 4
  if (ases === 1) return 36; // 1 As
  if (vals[0] <= 4 && vals[1] <= 5) return 25; // 4 y 5
  return 10;
}

function evaluarFuerzaPares(mano) {
  const p = evaluarDetallePares(mano);
  if (p.tipo === 4) return 99; // Cuarteto
  if (p.tipo === 3) {
    if (p.val1 === 12 && p.val2 === 12) return 98;
    if (p.val1 === 12) return 92; // Duples con Reyes
    if (p.val1 >= 10) return 86; // Duples con figuras
    return 80;
  }
  if (p.tipo === 2) {
    if (p.val1 === 12) return 82; // Medias de Reyes
    if (p.val1 >= 10) return 72; // Medias de figuras
    return 64;
  }
  if (p.tipo === 1) {
    if (p.val1 === 12) return 60; // Pareja de Reyes
    if (p.val1 === 11) return 52; // Pareja de Caballos
    if (p.val1 === 10) return 46; // Pareja de Sotas
    if (p.val1 === 1) return 40;  // Pareja de Ases
    return 35; // Pareja baja (4-7)
  }
  return 0;
}

function evaluarFuerzaJuego(mano, esAlPunto) {
  const j = evaluarDetalleJuego(mano);
  if (esAlPunto) {
    if (j.valor === 30) return 68; // El mejor punto posible
    if (j.valor === 29) return 55;
    if (j.valor === 28) return 45;
    if (j.valor >= 25) return 32;
    return 18;
  }
  if (j.tiene) {
    if (j.valor === 31) return 100; // La una (31)
    if (j.valor === 32) return 88;
    if (j.valor === 40) return 78;
    if (j.valor === 37) return 72;
    if (j.valor === 36) return 68;
    if (j.valor === 35) return 64;
    if (j.valor === 34) return 60;
    return 56; // 33
  }
  return 0;
}

function jugadorPuedeHablarEnLance(sala, asiento, lance) {
  const mano = sala.manos[asiento];
  if (!mano || mano.length === 0) return false;
  if (lance === 'pares') return evaluarDetallePares(mano).tipo > 0;
  if (lance === 'juego') {
    if (sala.apuestasLances.juego.esAlPunto) return true;
    return evaluarDetalleJuego(mano).tiene;
  }
  return true;
}

function obtenerEstadoAsientos(sala) {
  return ASIENTOS_INFO.map(a => {
    const j = Object.values(sala.jugadoresPorToken).find(p => p.asiento === a.id);
    return {
      id: a.id,
      nombreDef: a.nombreDef,
      pareja: a.pareja,
      nombrePareja: obtenerNombrePareja(sala, a.pareja),
      ocupado: !!j,
      ocupante: j?.nombre,
      avatar: j?.avatar || (j?.esBot ? '🤖' : '👑'),
      esBot: j?.esBot
    };
  });
}

function emitirActualizacionAsientos(sala) {
  io.to(sala.id).emit('asientosEstado', {
    asientos: obtenerEstadoAsientos(sala),
    nombresParejas: sala.nombresParejas || { 0: 'Pareja 1', 1: 'Pareja 2' }
  });
}

function enviarCartasAJugador(sala, j) {
  if (!j.esBot && j.socketId) {
    io.to(j.socketId).emit('misCartas', sala.manos[j.asiento] || []);
  }
}

function iniciarMano(sala) {
  limpiarTodosLosTimers(sala);
  sala.recuentoEnCurso = false;
  sala.pasosEnLance = 0;
  sala.mazo = crearMazo();
  sala.descartes = [];
  
  for (let i = 0; i < 4; i++) {
    sala.manos[i] = [];
    for (let c = 0; c < 4; c++) sala.manos[i].push(robarCarta(sala));
    sala.indicesCartaRevelada[i] = sala.modoLoco ? Math.floor(Math.random() * 4) : null;
  }

  sala.fase = 'mus';
  sala.turno = sala.asientoMano;
  sala.ordenMusVotos = {};
  sala.declaraciones = { pares: {}, juego: {} };
  sala.enPartida = true;
  sala.apuestaActual = { total: 0, ultimoAumento: 0, ultimoApostador: null, ordago: false, enPaso: true };
  sala.apuestasLances = {
    grande: { querido: false, puntos: 1, ordago: false, resueltoEnFalso: false },
    chica: { querido: false, puntos: 1, ordago: false, resueltoEnFalso: false },
    pares: { querido: false, puntos: 1, ordago: false, resueltoEnFalso: false, hayPares: false },
    juego: { querido: false, puntos: 1, ordago: false, resueltoEnFalso: false, esAlPunto: false }
  };
  const jMano = Object.values(sala.jugadoresPorToken).find(p => p.asiento === sala.asientoMano);
  const msgModo = sala.modoLoco ? " ¡MODO LOCO ACTIVO: 1 carta destapada por jugador!" : "";
  notificarEstado(sala, `Nueva mano repartida. Abre la mano: ${jMano?.nombre || `Asiento ${sala.asientoMano + 1}`}.${msgModo}`);
  comprobarTurnoBot(sala);
}

function notificarEstado(sala, msg, forzarRevelado = false) {
  let permisosHabla = {};
  for (let a = 0; a < 4; a++) {
    permisosHabla[a] = jugadorPuedeHablarEnLance(sala, a, sala.fase);
  }

  const revelarTodas = forzarRevelado || (sala.fase === 'recuento' || sala.fase === 'fin');

  const mapaJugadores = {};
  Object.values(sala.jugadoresPorToken).forEach(j => {
    mapaJugadores[j.asiento] = {
      asiento: j.asiento,
      nombre: j.nombre,
      avatar: j.avatar || (j.esBot ? '🤖' : '👑'),
      pareja: j.pareja,
      esBot: j.esBot
    };
  });

  let cartasReveladasModoLoco = {};
  if (sala.modoLoco) {
    for (let a = 0; a < 4; a++) {
      let idx = sala.indicesCartaRevelada[a];
      if (idx !== null && sala.manos[a] && sala.manos[a][idx]) {
        cartasReveladasModoLoco[a] = { indice: idx, carta: sala.manos[a][idx] };
      }
    }
  }

  let jugadasEspeciales = {};
  if (revelarTodas) {
    for (let a = 0; a < 4; a++) {
      let esp = detectarJugadaEspecial(sala.manos[a]);
      if (esp) jugadasEspeciales[a] = esp;
    }
  }

  io.to(sala.id).emit('estadoJuego', {
    fase: sala.fase,
    turno: sala.turno,
    asientoMano: sala.asientoMano,
    puntos: sala.puntos,
    chicosGanados: sala.chicosGanados,
    vacasGanadas: sala.vacasGanadas,
    nombresParejas: sala.nombresParejas || { 0: 'Pareja 1', 1: 'Pareja 2' },
    modoLoco: sala.modoLoco,
    cartasReveladasModoLoco: cartasReveladasModoLoco,
    apuestaActual: sala.apuestaActual,
    apuestasLances: sala.apuestasLances,
    decisionPareja: {
      activa: sala.decisionPareja.activa,
      parejaVotante: sala.decisionPareja.parejaVotante,
      votos: sala.decisionPareja.votos,
      tiempoRestante: sala.decisionPareja.tiempoRestante
    },
    permisosHabla: permisosHabla,
    mensaje: msg,
    jugadoresEnMesa: mapaJugadores,
    enPartida: sala.enPartida,
    todasLasManos: revelarTodas ? sala.manos : null,
    jugadasEspeciales: jugadasEspeciales
  });

  for (let token in sala.jugadoresPorToken) {
    enviarCartasAJugador(sala, sala.jugadoresPorToken[token]);
  }
}

function siguienteTurnoMus(sala) {
  const votos = Object.keys(sala.ordenMusVotos);
  if (votos.length === 4) {
    sala.fase = 'descartes';
    notificarEstado(sala, "¡Hay Mus corrido! Selecciona las cartas que quieras descartar.");
    procesarDescartesBots(sala);
  } else {
    sala.turno = (sala.asientoMano + votos.length) % 4;
    const j = Object.values(sala.jugadoresPorToken).find(p => p.asiento === sala.turno);
    notificarEstado(sala, `Turno de ${j?.nombre || 'Jugador'}: ¿Mus o Cortar?`);
    comprobarTurnoBot(sala);
  }
}

function obtenerPrimerJugadorHabilitado(sala, lance) {
  for (let i = 0; i < 4; i++) {
    const a = (sala.asientoMano + i) % 4;
    if (jugadorPuedeHablarEnLance(sala, a, lance)) {
      return a;
    }
  }
  return sala.asientoMano;
}

function contarJugadoresHabilitados(sala, lance) {
  let count = 0;
  for (let a = 0; a < 4; a++) {
    if (jugadorPuedeHablarEnLance(sala, a, lance)) count++;
  }
  return count;
}

function iniciarLance(sala, nombreLance) {
  limpiarTodosLosTimers(sala);
  sala.pasosEnLance = 0;

  if (nombreLance === 'pares') {
    sala.fase = 'declaracion_pares';
    sala.turno = sala.asientoMano;
    sala.declaraciones.pares = {};
    const jMano = Object.values(sala.jugadoresPorToken).find(p => p.asiento === sala.asientoMano);
    notificarEstado(sala, `¿Llevas Pares, ${jMano?.nombre || 'Mano'}?`);
    comprobarTurnoDeclaracionBot(sala);
    return;
  }

  if (nombreLance === 'juego') {
    sala.fase = 'declaracion_juego';
    sala.turno = sala.asientoMano;
    sala.declaraciones.juego = {};
    const jMano = Object.values(sala.jugadoresPorToken).find(p => p.asiento === sala.asientoMano);
    notificarEstado(sala, `¿Tienes Juego, ${jMano?.nombre || 'Mano'}?`);
    comprobarTurnoDeclaracionBot(sala);
    return;
  }

  sala.fase = nombreLance;
  sala.turno = sala.asientoMano;
  sala.apuestaActual = { total: 0, ultimoAumento: 0, ultimoApostador: null, ordago: false, enPaso: true };
  const jActual = Object.values(sala.jugadoresPorToken).find(p => p.asiento === sala.turno);
  notificarEstado(sala, `Ronda de ${nombreLance.toUpperCase()}. Habla ${jActual?.nombre || 'Mano'}.`);
  comprobarTurnoBot(sala);
}

function comprobarTurnoDeclaracionBot(sala) {
  if (sala.botTurnoTimer) {
    clearTimeout(sala.botTurnoTimer);
    sala.botTurnoTimer = null;
  }
  const demora = Math.floor(Math.random() * 500) + 1200;
  sala.botTurnoTimer = setTimeout(() => {
    sala.botTurnoTimer = null;
    const j = Object.values(sala.jugadoresPorToken).find(p => p.asiento === sala.turno);
    if (j && j.esBot) {
      if (sala.fase === 'declaracion_pares') {
        const tiene = evaluarDetallePares(sala.manos[j.asiento]).tipo > 0;
        procesarDeclaracionPares(sala, j.asiento, tiene);
      } else if (sala.fase === 'declaracion_juego') {
        const tiene = evaluarDetalleJuego(sala.manos[j.asiento]).tiene;
        procesarDeclaracionJuego(sala, j.asiento, tiene);
      }
    }
  }, demora);
}

function procesarDeclaracionPares(sala, asiento, lleva) {
  if (sala.fase !== 'declaracion_pares') return;
  if (sala.turno !== asiento) return;
  if (sala.declaraciones.pares[asiento] !== undefined) return;

  const tieneReal = evaluarDetallePares(sala.manos[asiento]).tipo > 0;
  if (lleva && !tieneReal) {
    lleva = false;
  }
  sala.declaraciones.pares[asiento] = lleva;
  const j = Object.values(sala.jugadoresPorToken).find(p => p.asiento === asiento);
  io.to(sala.id).emit('mensajeChat', { asiento, jugador: j?.nombre || 'Jugador', texto: lleva ? "¡Sí, llevo pares!" : "No llevo" });

  const respondidos = Object.keys(sala.declaraciones.pares).length;
  if (respondidos < 4) {
    sala.turno = (asiento + 1) % 4;
    const sig = Object.values(sala.jugadoresPorToken).find(p => p.asiento === sala.turno);
    notificarEstado(sala, `¿Llevas Pares, ${sig?.nombre || 'Jugador'}?`);
    comprobarTurnoDeclaracionBot(sala);
  } else {
    const p0 = sala.declaraciones.pares[0] || sala.declaraciones.pares[2];
    const p1 = sala.declaraciones.pares[1] || sala.declaraciones.pares[3];

    if (!p0 && !p1) {
      sala.apuestasLances.pares.hayPares = false;
      notificarEstado(sala, "Nadie tiene pares. Lance desierto.");
      programarTimerSala(sala, () => avanzarSiguienteLance(sala), 2000);
    } else if (p0 && !p1) {
      sala.apuestasLances.pares.hayPares = true;
      notificarEstado(sala, `Solo lleva pares ${obtenerNombrePareja(sala, 0)}. Se cobrarán al recuento.`);
      programarTimerSala(sala, () => avanzarSiguienteLance(sala), 2000);
    } else if (!p0 && p1) {
      sala.apuestasLances.pares.hayPares = true;
      notificarEstado(sala, `Solo lleva pares ${obtenerNombrePareja(sala, 1)}. Se cobrarán al recuento.`);
      programarTimerSala(sala, () => avanzarSiguienteLance(sala), 2000);
    } else {
      sala.apuestasLances.pares.hayPares = true;
      sala.fase = 'pares';
      sala.pasosEnLance = 0;
      sala.apuestaActual = { total: 0, ultimoAumento: 0, ultimoApostador: null, ordago: false, enPaso: true };
      sala.turno = obtenerPrimerJugadorHabilitado(sala, 'pares');
      const jActual = Object.values(sala.jugadoresPorToken).find(p => p.asiento === sala.turno);
      notificarEstado(sala, `Ronda de PARES. Habla ${jActual?.nombre || 'Jugador'}.`);
      comprobarTurnoBot(sala);
    }
  }
}

function procesarDeclaracionJuego(sala, asiento, lleva) {
  if (sala.fase !== 'declaracion_juego') return;
  if (sala.turno !== asiento) return;
  if (sala.declaraciones.juego[asiento] !== undefined) return;

  const tieneReal = evaluarDetalleJuego(sala.manos[asiento]).tiene;
  if (lleva && !tieneReal) {
    lleva = false;
  }
  sala.declaraciones.juego[asiento] = lleva;
  const j = Object.values(sala.jugadoresPorToken).find(p => p.asiento === asiento);
  io.to(sala.id).emit('mensajeChat', { asiento, jugador: j?.nombre || 'Jugador', texto: lleva ? "¡Sí, tengo juego!" : "No tengo" });

  const respondidos = Object.keys(sala.declaraciones.juego).length;
  if (respondidos < 4) {
    sala.turno = (asiento + 1) % 4;
    const sig = Object.values(sala.jugadoresPorToken).find(p => p.asiento === sala.turno);
    notificarEstado(sala, `¿Tienes Juego, ${sig?.nombre || 'Jugador'}?`);
    comprobarTurnoDeclaracionBot(sala);
  } else {
    const j0 = sala.declaraciones.juego[0] || sala.declaraciones.juego[2];
    const j1 = sala.declaraciones.juego[1] || sala.declaraciones.juego[3];

    if (!j0 && !j1) {
      sala.apuestasLances.juego.esAlPunto = true;
      sala.fase = 'juego';
      sala.pasosEnLance = 0;
      sala.turno = sala.asientoMano;
      sala.apuestaActual = { total: 0, ultimoAumento: 0, ultimoApostador: null, ordago: false, enPaso: true };
      const jMano = Object.values(sala.jugadoresPorToken).find(p => p.asiento === sala.asientoMano);
      notificarEstado(sala, `Nadie tiene juego: ronda Al Punto. Habla ${jMano?.nombre || 'Mano'}.`);
      comprobarTurnoBot(sala);
    } else if (j0 && !j1) {
      sala.apuestasLances.juego.esAlPunto = false;
      notificarEstado(sala, `Solo lleva juego ${obtenerNombrePareja(sala, 0)}. Se cobrará al recuento.`);
      programarTimerSala(sala, () => avanzarSiguienteLance(sala), 2000);
    } else if (!j0 && j1) {
      sala.apuestasLances.juego.esAlPunto = false;
      notificarEstado(sala, `Solo lleva juego ${obtenerNombrePareja(sala, 1)}. Se cobrará al recuento.`);
      programarTimerSala(sala, () => avanzarSiguienteLance(sala), 2000);
    } else {
      sala.apuestasLances.juego.esAlPunto = false;
      sala.fase = 'juego';
      sala.pasosEnLance = 0;
      sala.apuestaActual = { total: 0, ultimoAumento: 0, ultimoApostador: null, ordago: false, enPaso: true };
      sala.turno = obtenerPrimerJugadorHabilitado(sala, 'juego');
      const jActual = Object.values(sala.jugadoresPorToken).find(p => p.asiento === sala.turno);
      notificarEstado(sala, `Ronda de JUEGO. Habla ${jActual?.nombre || 'Jugador'}.`);
      comprobarTurnoBot(sala);
    }
  }
}

function iniciarDecisionConjunta(sala, parejaVotante) {
  limpiarTimersBots(sala);
  limpiarTimerDecision(sala);

  sala.decisionPareja = {
    activa: true,
    parejaVotante: parejaVotante,
    votos: {},
    tiempoRestante: 12,
    timerId: null
  };

  notificarEstado(sala, `¡Envite en la mesa! ${obtenerNombrePareja(sala, parejaVotante)} delibera su respuesta...`);

  for (let token in sala.jugadoresPorToken) {
    const j = sala.jugadoresPorToken[token];
    if (j.esBot && ASIENTOS_INFO[j.asiento].pareja === parejaVotante) {
      if (jugadorPuedeHablarEnLance(sala, j.asiento, sala.fase)) {
        const delayBot = Math.floor(Math.random() * 800) + 1400;
        let t = setTimeout(() => {
          let votoBot = botCalcularRespuestaEnvite(sala, j.asiento, sala.fase, sala.apuestaActual);
          registrarVotoPareja(sala, j.asiento, votoBot);
        }, delayBot);
        sala.botDecisionTimers.push(t);
      } else {
        registrarVotoPareja(sala, j.asiento, { tipo: 'noquiero', noPuedeHablar: true });
      }
    }
  }

  sala.decisionPareja.timerId = setInterval(() => {
    sala.decisionPareja.tiempoRestante--;
    io.to(sala.id).emit('tickTimer', { tiempo: sala.decisionPareja.tiempoRestante });
    if (sala.decisionPareja.tiempoRestante <= 0) {
      finalizarDecisionPareja(sala, true);
    }
  }, 1000);
}

function limpiarTimerDecision(sala) {
  if (sala.decisionPareja && sala.decisionPareja.timerId) {
    clearInterval(sala.decisionPareja.timerId);
    sala.decisionPareja.timerId = null;
  }
  sala.decisionPareja.activa = false;
  sala.decisionPareja.votos = {};
}

function registrarVotoPareja(sala, asiento, accion) {
  if (!sala.decisionPareja || !sala.decisionPareja.activa) return;
  const parejaJugador = ASIENTOS_INFO[asiento].pareja;
  if (parejaJugador !== sala.decisionPareja.parejaVotante) return;

  // Ante un órdago, solo se permite 'quiero' o 'noquiero' (no se puede re-envidar)
  if (sala.apuestaActual && sala.apuestaActual.ordago) {
    if (accion.tipo !== 'quiero' && accion.tipo !== 'noquiero') {
      accion = { tipo: 'noquiero' };
    }
  }

  sala.decisionPareja.votos[asiento] = accion;
  const j = Object.values(sala.jugadoresPorToken).find(p => p.asiento === asiento);
  io.to(sala.id).emit('votoParejaEmitido', { asiento, nombre: j?.nombre || 'Jugador', accion });

  notificarEstado(sala, `Voto emitido por ${j?.nombre || 'Jugador'}`);

  const asientosAsignados = ASIENTOS_INFO
    .filter(a => a.pareja === parejaJugador)
    .map(a => a.id)
    .filter(aId => Object.values(sala.jugadoresPorToken).some(p => p.asiento === aId));

  const asientosHabilitados = asientosAsignados.filter(a => jugadorPuedeHablarEnLance(sala, a, sala.fase));

  const todosVotaron = asientosHabilitados.every(a => sala.decisionPareja.votos[a] !== undefined);
  if (todosVotaron) {
    setTimeout(() => {
      finalizarDecisionPareja(sala, false);
    }, 700);
  }
}

function finalizarDecisionPareja(sala, porTiempo) {
  if (!sala.decisionPareja || !sala.decisionPareja.activa) return;
  limpiarTimersBots(sala);
  const votos = { ...sala.decisionPareja.votos };
  const pareja = sala.decisionPareja.parejaVotante;
  const nomPareja = obtenerNombrePareja(sala, pareja);
  const esOrdagoActivo = sala.apuestaActual.ordago;
  limpiarTimerDecision(sala);

  const listaAcciones = Object.values(votos);
  let decisionFinal = { tipo: 'noquiero' };

  if (esOrdagoActivo) {
    // Si hay un órdago, solo se puede ver o no ver. No existe reenvite.
    if (listaAcciones.some(a => a.tipo === 'quiero')) {
      decisionFinal = { tipo: 'quiero' };
    } else {
      decisionFinal = { tipo: 'noquiero' };
    }
  } else {
    if (listaAcciones.some(a => a.tipo === 'ordago')) {
      decisionFinal = { tipo: 'ordago' };
    } else if (listaAcciones.some(a => a.tipo === 'envidar')) {
      const maxAumento = Math.max(...listaAcciones.filter(a => a.tipo === 'envidar').map(a => a.cantidad || 2));
      decisionFinal = { tipo: 'envidar', cantidad: maxAumento };
    } else if (listaAcciones.some(a => a.tipo === 'quiero')) {
      decisionFinal = { tipo: 'quiero' };
    }
  }

  if (esOrdagoActivo && decisionFinal.tipo === 'quiero') {
    io.to(sala.id).emit('mensajeChat', { asiento: -1, jugador: nomPareja, texto: "¡QUIERO EL ÓRDAGO!" });
    resolverOrdagoInmediato(sala, sala.fase);
    return;
  }

  if (decisionFinal.tipo === 'ordago') {
    sala.apuestaActual.ordago = true;
    sala.apuestaActual.ultimoApostador = pareja;
    sala.apuestaActual.enPaso = false;
    io.to(sala.id).emit('mensajeChat', { asiento: -1, jugador: nomPareja, texto: "¡ÓRDAGO de réplica!" });
    iniciarDecisionConjunta(sala, pareja === 0 ? 1 : 0);
  } else if (decisionFinal.tipo === 'envidar') {
    const aumento = decisionFinal.cantidad;
    sala.apuestaActual.total += aumento;
    sala.apuestaActual.ultimoAumento = aumento;
    sala.apuestaActual.ultimoApostador = pareja;
    sala.apuestaActual.enPaso = false;
    io.to(sala.id).emit('mensajeChat', { asiento: -1, jugador: nomPareja, texto: `¡Re-envidado ${aumento} más! (Bote: ${sala.apuestaActual.total})` });
    iniciarDecisionConjunta(sala, pareja === 0 ? 1 : 0);
  } else if (decisionFinal.tipo === 'quiero') {
    io.to(sala.id).emit('mensajeChat', { asiento: -1, jugador: nomPareja, texto: "¡QUIERO!" });
    sala.apuestasLances[sala.fase].querido = true;
    sala.apuestasLances[sala.fase].puntos = sala.apuestaActual.total;
    notificarEstado(sala, `¡Envite de ${sala.apuestasLances[sala.fase].puntos} puntos aceptado! Se cobrará al recuento.`);
    programarTimerSala(sala, () => avanzarSiguienteLance(sala), 2200);
  } else {
    io.to(sala.id).emit('mensajeChat', { asiento: -1, jugador: nomPareja, texto: porTiempo ? "Tiempo agotado: No quiero" : "No quiero" });
    const ganadora = sala.apuestaActual.ultimoApostador !== null ? sala.apuestaActual.ultimoApostador : (pareja === 0 ? 1 : 0);
    const nomGanadora = obtenerNombrePareja(sala, ganadora);

    let ptsGanados = 1;
    let descCobro = "";
    if (esOrdagoActivo) {
      if (sala.apuestaActual.total > 0) {
        ptsGanados = sala.apuestaActual.total;
        descCobro = `Órdago rechazado: ${nomGanadora} se lleva el bote de ${ptsGanados} pts`;
      } else {
        ptsGanados = 1;
        descCobro = `Órdago directo rechazado (+1 pto para ${nomGanadora})`;
      }
    } else if (sala.apuestaActual.total > sala.apuestaActual.ultimoAumento) {
      ptsGanados = sala.apuestaActual.total - sala.apuestaActual.ultimoAumento;
      descCobro = `Envite rechazado: Bote de ${sala.apuestaActual.total} menos última subida de ${sala.apuestaActual.ultimoAumento} (+${ptsGanados} pts para ${nomGanadora})`;
    } else {
      descCobro = `Envite de ${sala.apuestaActual.total} no querido (+1 pto para ${nomGanadora})`;
    }

    sala.puntos[ganadora] += ptsGanados;

    sala.apuestasLances[sala.fase].resueltoEnFalso = true;
    sala.apuestasLances[sala.fase].puntosEnFalso = ptsGanados;
    sala.apuestasLances[sala.fase].ganadorEnFalso = ganadora;
    sala.apuestasLances[sala.fase].descEnFalso = descCobro;
    sala.apuestasLances[sala.fase].totalBote = sala.apuestaActual.total;
    sala.apuestasLances[sala.fase].ultimoAumento = sala.apuestaActual.ultimoAumento;
    sala.apuestasLances[sala.fase].enPaso = false;

    const nombreLance = (sala.fase === 'juego' && sala.apuestasLances.juego.esAlPunto)
      ? 'AL PUNTO'
      : sala.fase.toUpperCase();

    // Registrar inmediatamente en el Registro de Lances para que aparezca en tiempo real
    io.to(sala.id).emit('eventoLanceGanado', {
      lance: nombreLance,
      asientoGanador: ganadora === 0 ? 0 : 1,
      parejaGanadora: ganadora,
      desglose: `Envite de ${nombreLance} no querido: +${ptsGanados} pt(s) para ${nomGanadora}.`,
      desgloseItems: [{ desc: descCobro, pts: ptsGanados, jugador: nomGanadora }],
      puntosActualizados: sala.puntos,
      esOrdagoDirecto: false
    });

    notificarEstado(sala, `No querido. +${ptsGanados} punto(s) para ${nomGanadora} (${descCobro}).`);

    if (comprobarVictoriaChico(sala)) return;
    programarTimerSala(sala, () => avanzarSiguienteLance(sala), 2200);
  }
}

function resolverOrdagoInmediato(sala, lance) {
  limpiarTodosLosTimers(sala);
  sala.fase = 'recuento';

  notificarEstado(sala, `¡ÓRDAGO ACEPTADO EN ${lance.toUpperCase()}! ¡A ver las cartas!`, true);

  programarTimerSala(sala, () => {
    const resultado = evaluarGanadorLanceDetalle(sala, lance);
    const ganador = resultado.parejaGanadora;
    const asientoGanador = resultado.asientoGanador;
    const motivoOrdago = `¡ÓRDAGO GANADO EN ${lance.toUpperCase()} por ${resultado.nombreGanador}! (${resultado.motivo})`;

    io.to(sala.id).emit('eventoLanceGanado', {
      lance: lance.toUpperCase(),
      asientoGanador: asientoGanador,
      parejaGanadora: ganador,
      desglose: motivoOrdago,
      desgloseItems: [{ desc: "Órdago aceptado y ganado", pts: 40, jugador: resultado.nombreGanador }],
      puntosActualizados: { 0: 0, 1: 0 },
      esOrdagoDirecto: true
    });

    notificarEstado(sala, motivoOrdago, true);
    comprobarVictoriaChico(sala, ganador, motivoOrdago, true);
  }, 2600);
}

function ejecutarAccionLance(sala, jugador, { tipo, cantidad, mensaje }) {
  if (!['grande', 'chica', 'pares', 'juego'].includes(sala.fase)) return;
  if (sala.turno !== jugador.asiento) return;
  if (!jugadorPuedeHablarEnLance(sala, jugador.asiento, sala.fase)) return;

  const pareja = ASIENTOS_INFO[jugador.asiento].pareja;
  const parejaRival = pareja === 0 ? 1 : 0;

  if (tipo === 'paso') {
    io.to(sala.id).emit('mensajeChat', { asiento: jugador.asiento, jugador: jugador.nombre, texto: "Paso" });
    sala.pasosEnLance = (sala.pasosEnLance || 0) + 1;

    const habilitados = contarJugadoresHabilitados(sala, sala.fase);
    if (sala.pasosEnLance >= habilitados) {
      sala.apuestasLances[sala.fase].enPaso = true;
      sala.apuestasLances[sala.fase].puntos = 1;
      const nombreLance = (sala.fase === 'juego' && sala.apuestasLances.juego.esAlPunto) ? 'AL PUNTO' : sala.fase.toUpperCase();
      notificarEstado(sala, `La ronda de ${nombreLance} queda en paso.`);
      programarTimerSala(sala, () => avanzarSiguienteLance(sala), 1800);
      return;
    }

    // Buscar al siguiente jugador habilitado
    let sig = (sala.turno + 1) % 4;
    while (!jugadorPuedeHablarEnLance(sala, sig, sala.fase)) {
      sig = (sig + 1) % 4;
    }
    sala.turno = sig;
    const jActual = Object.values(sala.jugadoresPorToken).find(p => p.asiento === sala.turno);
    const nombreLance = (sala.fase === 'juego' && sala.apuestasLances.juego.esAlPunto) ? 'AL PUNTO' : sala.fase.toUpperCase();
    notificarEstado(sala, `Ronda de ${nombreLance}. Habla ${jActual?.nombre || 'Jugador'}.`);
    comprobarTurnoBot(sala);
  } else if (tipo === 'envidar') {
    const aumento = parseInt(cantidad) || 2;
    sala.apuestaActual.total += aumento;
    sala.apuestaActual.ultimoAumento = aumento;
    sala.apuestaActual.ultimoApostador = pareja;
    sala.apuestaActual.enPaso = false;

    const textoBase = sala.apuestaActual.total === aumento ? `¡Envido ${aumento}!` : `¡${aumento} más! (Bote: ${sala.apuestaActual.total})`;
    const texto = mensaje || textoBase;
    io.to(sala.id).emit('mensajeChat', { asiento: jugador.asiento, jugador: jugador.nombre, texto });
    iniciarDecisionConjunta(sala, parejaRival);
  } else if (tipo === 'ordago') {
    sala.apuestaActual.ordago = true;
    sala.apuestaActual.ultimoApostador = pareja;
    sala.apuestaActual.enPaso = false;

    io.to(sala.id).emit('mensajeChat', { asiento: jugador.asiento, jugador: jugador.nombre, texto: "¡ÓRDAGO!" });
    iniciarDecisionConjunta(sala, parejaRival);
  }
}

const ESTILOS_BOT = {
  picaro: {
    nombre: "El Pillo",
    avatar: "🦊",
    probRoboPaso: 0.88,
    probFarol: 0.22,
    probReenvite: 0.38,
    frasesRobo: [
      "¡Al paso nada! Envido 2.",
      "Si nadie abre, pruebo yo: ¡Envido 2!",
      "De postre no se regala nada: ¡Envido 2!",
      "¿Todos de paso? ¡Pues envido 2!"
    ],
    frasesFarol: [
      "Por probar que no quede: ¡Envido 2!",
      "A ver quién tiene valor... ¡Envido 2!",
      "¡Envido 2!"
    ]
  },
  agresivo: {
    nombre: "El Bravo",
    avatar: "🦁",
    probRoboPaso: 0.78,
    probFarol: 0.18,
    probReenvite: 0.48,
    frasesRobo: [
      "¡Aquí no pasa nadie gratis! Envido 2.",
      "Para que haya emoción: ¡Envido 2!",
      "¡Envido 2!"
    ],
    frasesFarol: [
      "¡A ver si las veis! Envido 2.",
      "¡Envido 2!"
    ]
  },
  amarrategui: {
    nombre: "Don Cauto",
    avatar: "🛡️",
    probRoboPaso: 0.50,
    probFarol: 0.05,
    probReenvite: 0.15,
    frasesRobo: [
      "Asegurando el lance: Envido 2.",
      "Bueno, dos puntitos... ¡Envido 2!"
    ],
    frasesFarol: [
      "¡Envido 2!"
    ]
  },
  experto: {
    nombre: "El Maestro",
    avatar: "🧙‍♂️",
    probRoboPaso: 0.82,
    probFarol: 0.14,
    probReenvite: 0.32,
    frasesRobo: [
      "Aprovechando la posición: ¡Envido 2!",
      "No hay que dejarlo en paso: Envido 2.",
      "Si vais de paso, me toca a mí: ¡Envido 2!"
    ],
    frasesFarol: [
      "Un tiento a ver qué pasa: ¡Envido 2!",
      "¡Envido 2!"
    ]
  }
};

const PERFILES_BOT_ASIENTOS = [
  { nombre: "Don Cauto", avatar: "🛡️", estilo: "amarrategui" },
  { nombre: "El Pillo", avatar: "🦊", estilo: "picaro" },
  { nombre: "El Maestro", avatar: "🧙‍♂️", estilo: "experto" },
  { nombre: "El Bravo", avatar: "🦁", estilo: "agresivo" }
];

function botElegirDescartes(mano) {
  if (!mano || !Array.isArray(mano) || mano.length === 0) return [];

  const j = evaluarDetalleJuego(mano);
  if (j.tiene && (j.valor === 31 || j.valor === 32)) return [];
  const p = evaluarDetallePares(mano);
  if (p.tipo === 4 || (p.tipo === 3 && p.val1 === 12)) return [];

  const descartarIndices = [];
  const reyesIndices = [];
  const asesIndices = [];

  mano.forEach((c, idx) => {
    if (!c) return;
    if (c.valorMus === 12) reyesIndices.push(idx);
    else if (c.valorMus === 1) asesIndices.push(idx);
  });

  // Si tiene 2 o más Reyes, guarda los Reyes e intenta buscar más
  if (reyesIndices.length >= 2) {
    mano.forEach((c, idx) => {
      if (!c) return;
      if (!reyesIndices.includes(idx)) {
        if (c.valorMus === 1 && reyesIndices.length === 2 && Math.random() < 0.6) return;
        descartarIndices.push(idx);
      }
    });
    return descartarIndices;
  }

  // Si tiene 2 o más Ases, guarda los Ases
  if (asesIndices.length >= 2) {
    mano.forEach((c, idx) => {
      if (!c) return;
      if (!asesIndices.includes(idx)) descartarIndices.push(idx);
    });
    return descartarIndices;
  }

  // Si tiene otra pareja
  if (p.tipo >= 1) {
    let cuentaValores = {};
    mano.forEach(c => {
      if (c && c.valorMus !== undefined) {
        cuentaValores[c.valorMus] = (cuentaValores[c.valorMus] || 0) + 1;
      }
    });
    mano.forEach((c, idx) => {
      if (!c) return;
      if ((cuentaValores[c.valorMus] || 0) < 2) {
        if (c.valorMus === 12 || c.valorMus === 1) {
          if (Math.random() < 0.4) return;
        }
        descartarIndices.push(idx);
      }
    });
    return descartarIndices;
  }

  // Ciego o dispersa: guarda Reyes o Ases sueltos, descarta el resto
  mano.forEach((c, idx) => {
    if (!c) return;
    if (c.valorMus === 12 || c.valorMus === 1) return;
    descartarIndices.push(idx);
  });

  if (descartarIndices.length === 0) {
    return [0, 1, 2, 3];
  }

  return descartarIndices;
}

function botDebeCortarMus(sala, asiento) {
  const mano = sala.manos[asiento];
  const jBot = Object.values(sala.jugadoresPorToken).find(p => p.asiento === asiento);
  const estiloClave = jBot?.estilo || 'experto';

  const j = evaluarDetalleJuego(mano);
  const p = evaluarDetallePares(mano);
  const g = evaluarFuerzaGrande(mano);

  if (j.tiene && j.valor === 31) {
    if (asiento === sala.asientoMano) return Math.random() < 0.88;
    return Math.random() < 0.75;
  }

  if (p.tipo >= 3) return true;
  if (g >= 95) return true;

  const parejaMia = ASIENTOS_INFO[asiento].pareja;
  const parejaRival = parejaMia === 0 ? 1 : 0;
  if ((sala.puntos[parejaRival] || 0) >= 36) {
    if (p.tipo >= 1 || g >= 70) return true;
  }

  if (estiloClave === 'agresivo') {
    if (p.tipo >= 2 || (g >= 72 && Math.random() < 0.50)) return true;
  }

  return false;
}

function botCalcularAccionApertura(sala, asiento, lance) {
  const mano = sala.manos[asiento];
  const jBot = Object.values(sala.jugadoresPorToken).find(p => p.asiento === asiento);
  const estiloClave = jBot?.estilo || 'experto';
  const estilo = ESTILOS_BOT[estiloClave] || ESTILOS_BOT.experto;

  const esAlPunto = (lance === 'juego' && !!sala.apuestasLances.juego.esAlPunto);
  let fuerza = 0;
  if (lance === 'grande') fuerza = evaluarFuerzaGrande(mano);
  else if (lance === 'chica') fuerza = evaluarFuerzaChica(mano);
  else if (lance === 'pares') fuerza = evaluarFuerzaPares(mano);
  else if (lance === 'juego') fuerza = evaluarFuerzaJuego(mano, esAlPunto);

  const parejaMia = ASIENTOS_INFO[asiento].pareja;
  const parejaRival = parejaMia === 0 ? 1 : 0;
  const ptsMios = sala.puntos[parejaMia] || 0;
  const ptsRivales = sala.puntos[parejaRival] || 0;
  const cercaGanar = (ptsMios >= 35);

  const habilitados = contarJugadoresHabilitados(sala, lance);
  const pasos = sala.pasosEnLance || 0;
  const esPostre = (pasos >= habilitados - 1);
  const rivalesPasaron = (pasos >= 1);

  // 1. OPORTUNIDAD: ROBAR EL LANCE AL PASO (aprovecharse de que los demás han pasado)
  if (rivalesPasaron && (esPostre || Math.random() < 0.70)) {
    let umbralDecente = 38;
    if (lance === 'chica') umbralDecente = 34;
    else if (lance === 'pares') umbralDecente = 35;
    else if (lance === 'juego') umbralDecente = esAlPunto ? 42 : 55;

    if (fuerza >= umbralDecente) {
      if (Math.random() < estilo.probRoboPaso) {
        const frase = (Math.random() < 0.45 && estilo.frasesRobo)
          ? estilo.frasesRobo[Math.floor(Math.random() * estilo.frasesRobo.length)]
          : "¡Envido 2!";
        return { tipo: 'envidar', cantidad: 2, mensaje: frase, esRoboPaso: true };
      }
    } else if (esPostre && Math.random() < estilo.probFarol) {
      // FAROL DE POSTRE
      const fraseFarol = (Math.random() < 0.40 && estilo.frasesFarol)
        ? estilo.frasesFarol[Math.floor(Math.random() * estilo.frasesFarol.length)]
        : "¡Envido 2!";
      return { tipo: 'envidar', cantidad: 2, mensaje: fraseFarol, esFarol: true };
    }
  }

  // 2. APERTURA CON MANO MUY FUERTE (>= 88)
  if (fuerza >= 88) {
    if (fuerza >= 95 && Math.random() < 0.30) {
      return { tipo: 'envidar', cantidad: 5 };
    }
    if (!esPostre && Math.random() < 0.08) {
      return { tipo: 'paso' };
    }
    return { tipo: 'envidar', cantidad: 2 };
  }

  // 3. APERTURA CON MANO FIRME (>= 66)
  if (fuerza >= 66) {
    if (Math.random() < 0.82) {
      return { tipo: 'envidar', cantidad: 2 };
    }
    return { tipo: 'paso' };
  }

  // 4. APERTURA CON MANO MEDIA (>= 48)
  if (fuerza >= 48) {
    if (cercaGanar && Math.random() < 0.70) {
      return { tipo: 'envidar', cantidad: 2 };
    }
    if (estiloClave === 'agresivo' && Math.random() < 0.45) {
      return { tipo: 'envidar', cantidad: 2 };
    }
    return { tipo: 'paso' };
  }

  // 5. APERTURA CON FAROL ESPORÁDICO
  if (Math.random() < (estilo.probFarol * 0.4)) {
    return { tipo: 'envidar', cantidad: 2, esFarol: true };
  }

  return { tipo: 'paso' };
}

function botCalcularRespuestaEnvite(sala, asiento, lance, apuestaActual) {
  const mano = sala.manos[asiento];
  const jBot = Object.values(sala.jugadoresPorToken).find(p => p.asiento === asiento);
  const estiloClave = jBot?.estilo || 'experto';
  const estilo = ESTILOS_BOT[estiloClave] || ESTILOS_BOT.experto;

  const esMano = tieneManoRelativa(asiento, sala);
  const esAlPunto = (lance === 'juego' && !!sala.apuestasLances.juego.esAlPunto);

  const parejaMia = ASIENTOS_INFO[asiento].pareja;
  const parejaRival = parejaMia === 0 ? 1 : 0;
  const ptsMios = sala.puntos[parejaMia] || 0;
  const ptsRivales = sala.puntos[parejaRival] || 0;
  const cercaGanar = (ptsMios >= 35);
  const rivalCercaGanar = (ptsRivales >= 35);

  let fuerza = 0;
  if (lance === 'grande') fuerza = evaluarFuerzaGrande(mano);
  else if (lance === 'chica') fuerza = evaluarFuerzaChica(mano);
  else if (lance === 'pares') fuerza = evaluarFuerzaPares(mano);
  else if (lance === 'juego') fuerza = evaluarFuerzaJuego(mano, esAlPunto);

  // Comprobar voto de compañero de pareja si ya votó
  const asientoComp = (asiento + 2) % 4;
  const votoComp = (sala.decisionPareja && sala.decisionPareja.votos) ? sala.decisionPareja.votos[asientoComp] : null;

  // A. ÓRDAGO
  if (apuestaActual.ordago) {
    if (votoComp && votoComp.tipo === 'quiero') return { tipo: 'quiero' };

    if (lance === 'grande') {
      const reyes = mano.filter(c => c && c.valorMus === 12).length;
      if (reyes === 4) return { tipo: 'quiero' };
      if (reyes === 3) {
        const cuarta = mano.map(c => c ? c.valorMus : 0).sort((a,b) => b-a)[3];
        if (cuarta >= 10 && (esMano || rivalCercaGanar)) return { tipo: 'quiero' };
        if (rivalCercaGanar && Math.random() < 0.65) return { tipo: 'quiero' };
      }
      return { tipo: 'noquiero' };
    }

    if (lance === 'chica') {
      const ases = mano.filter(c => c && c.valorMus === 1).length;
      if (ases === 4) return { tipo: 'quiero' };
      if (ases === 3 && (esMano || rivalCercaGanar)) return { tipo: 'quiero' };
      return { tipo: 'noquiero' };
    }

    if (lance === 'pares') {
      const p = evaluarDetallePares(mano);
      if (p.tipo === 4 && (p.val1 === 12 || p.val1 === 1)) return { tipo: 'quiero' };
      if (p.tipo === 3 && p.val1 === 12 && p.val2 >= 10 && esMano) return { tipo: 'quiero' };
      if (p.tipo === 3 && p.val1 === 12 && rivalCercaGanar && Math.random() < 0.70) return { tipo: 'quiero' };
      return { tipo: 'noquiero' };
    }

    if (lance === 'juego') {
      const j = evaluarDetalleJuego(mano);
      if (j.tiene && j.valor === 31) {
        if (esMano) return { tipo: 'quiero' };
        return Math.random() < 0.85 ? { tipo: 'quiero' } : { tipo: 'noquiero' };
      }
      if (j.tiene && j.valor === 32 && esMano && rivalCercaGanar && Math.random() < 0.50) {
        return { tipo: 'quiero' };
      }
      return { tipo: 'noquiero' };
    }

    return { tipo: 'noquiero' };
  }

  // B. ENVITE NORMAL
  let fuerzaEfectiva = fuerza;
  if (esMano) fuerzaEfectiva += 10;
  if (rivalCercaGanar) fuerzaEfectiva += 12;
  if (sala.pasosEnLance >= 1) fuerzaEfectiva += 8;

  // Solidaridad con el compañero si ya votó ver
  if (votoComp && votoComp.tipo === 'quiero' && fuerzaEfectiva >= 35) {
    return { tipo: 'quiero' };
  }

  const total = apuestaActual.total || 2;

  // Re-envidar (subir 2 más)
  if (total <= 4 && fuerzaEfectiva >= 86 && Math.random() < estilo.probReenvite) {
    return { tipo: 'envidar', cantidad: 2 };
  }
  if (total <= 2 && fuerzaEfectiva >= 68 && (estiloClave === 'agresivo' || estiloClave === 'picaro') && Math.random() < 0.35) {
    return { tipo: 'envidar', cantidad: 2 };
  }

  // Quiero (aceptar)
  if (total <= 2) {
    if (fuerzaEfectiva >= 42) return { tipo: 'quiero' };
    if (cercaGanar && fuerzaEfectiva >= 35) return { tipo: 'quiero' };
    if (rivalCercaGanar && fuerzaEfectiva >= 32) return { tipo: 'quiero' };
  } else if (total <= 4) {
    if (fuerzaEfectiva >= 60) return { tipo: 'quiero' };
  } else if (total <= 6) {
    if (fuerzaEfectiva >= 72) return { tipo: 'quiero' };
  } else if (total <= 10) {
    if (fuerzaEfectiva >= 84) return { tipo: 'quiero' };
  }

  return { tipo: 'noquiero' };
}

function comprobarTurnoBot(sala) {
  if (sala.botTurnoTimer) clearTimeout(sala.botTurnoTimer);

  const pausaBot = Math.floor(Math.random() * 700) + 1400;
  sala.botTurnoTimer = setTimeout(() => {
    sala.botTurnoTimer = null;
    if (sala.fase === 'mus') {
      const jActual = Object.values(sala.jugadoresPorToken).find(j => j.asiento === sala.turno);
      if (jActual && jActual.esBot) {
        const corta = botDebeCortarMus(sala, jActual.asiento);
        if (!corta) {
          sala.ordenMusVotos[jActual.asiento] = true;
          io.to(sala.id).emit('mensajeChat', { asiento: jActual.asiento, jugador: jActual.nombre, texto: "¡Mus!" });
          siguienteTurnoMus(sala);
        } else {
          const frasesCorto = [
            "¡Corto! No hay mus.",
            "¡Corto! Aquí hay cartas.",
            "¡No hay mus! A jugar.",
            "¡Corto el mus!"
          ];
          const txt = frasesCorto[Math.floor(Math.random() * frasesCorto.length)];
          io.to(sala.id).emit('mensajeChat', { asiento: jActual.asiento, jugador: jActual.nombre, texto: txt });
          iniciarLance(sala, 'grande');
        }
      }
    } else if (['grande', 'chica', 'pares', 'juego'].includes(sala.fase)) {
      const infoLance = sala.apuestasLances[sala.fase];
      if (infoLance && (infoLance.querido || infoLance.resueltoEnFalso || infoLance.enPaso)) {
        return;
      }
      if (!sala.decisionPareja || !sala.decisionPareja.activa) {
        const jActual = Object.values(sala.jugadoresPorToken).find(j => j.asiento === sala.turno);
        if (jActual && jActual.esBot) {
          if (!jugadorPuedeHablarEnLance(sala, jActual.asiento, sala.fase)) {
            ejecutarAccionLance(sala, jActual, { tipo: 'paso' });
          } else {
            const accion = botCalcularAccionApertura(sala, jActual.asiento, sala.fase);
            ejecutarAccionLance(sala, jActual, accion);
          }
        }
      }
    }
  }, pausaBot);
}

function procesarDescartesBots(sala) {
  Object.values(sala.jugadoresPorToken).filter(j => j.esBot).forEach(bot => {
    let mano = sala.manos[bot.asiento] || [];
    const indicesADescartar = botElegirDescartes(mano);
    let soltadas = indicesADescartar.length;

    indicesADescartar.forEach(idx => {
      if (mano[idx]) {
        sala.descartes.push(mano[idx]);
        mano[idx] = robarCarta(sala);
      }
    });

    io.to(sala.id).emit('eventoDescarteAnim', {
      asiento: bot.asiento,
      cantidad: soltadas
    });

    sala.ordenMusVotos[bot.asiento] = 'listo';
  });
  comprobarFinDescartes(sala);
}

function comprobarFinDescartes(sala) {
  if (Object.values(sala.ordenMusVotos).filter(v => v === 'listo').length === 4) {
    sala.ordenMusVotos = {};
    sala.fase = 'mus';
    sala.turno = sala.asientoMano;

    io.to(sala.id).emit('eventoRepartoMazoAnim');
    notificarEstado(sala, "Todos servidos. Repartiendo nuevas cartas...");

    programarTimerSala(sala, () => {
      const jMano = Object.values(sala.jugadoresPorToken).find(p => p.asiento === sala.asientoMano);
      notificarEstado(sala, `Cartas repartidas. ¿Mus o Cortar, ${jMano?.nombre || 'Mano'}?`);
      comprobarTurnoBot(sala);
    }, 1200);
  }
}

function avanzarSiguienteLance(sala) {
  limpiarTodosLosTimers(sala);
  const lances = ['grande', 'chica', 'pares', 'juego'];
  let idx = lances.indexOf(sala.fase.replace('declaracion_', ''));
  if (idx !== -1 && idx < lances.length - 1) {
    iniciarLance(sala, lances[idx + 1]);
  } else {
    ejecutarRecuentoFinalMano(sala);
  }
}

function ejecutarRecuentoFinalMano(sala) {
  if (sala.recuentoEnCurso) return;
  sala.recuentoEnCurso = true;
  limpiarTodosLosTimers(sala);

  sala.fase = 'recuento';
  notificarEstado(sala, "¡A enseñar cartas! Volteando las manos para el recuento...");

  programarTimerSala(sala, () => {
    let ordagoResuelto = resolverLanceEnRecuento(sala, 'grande');
    if (ordagoResuelto || comprobarVictoriaChico(sala)) {
      sala.recuentoEnCurso = false;
      return;
    }

    programarTimerSala(sala, () => {
      ordagoResuelto = resolverLanceEnRecuento(sala, 'chica');
      if (ordagoResuelto || comprobarVictoriaChico(sala)) {
        sala.recuentoEnCurso = false;
        return;
      }

      const continuarConJuego = () => {
        programarTimerSala(sala, () => {
          ordagoResuelto = resolverLanceEnRecuento(sala, 'juego');
          if (ordagoResuelto || comprobarVictoriaChico(sala)) {
            sala.recuentoEnCurso = false;
            return;
          }

          programarTimerSala(sala, () => {
            sala.asientoMano = (sala.asientoMano + 1) % 4;
            const nuevoMano = Object.values(sala.jugadoresPorToken).find(p => p.asiento === sala.asientoMano);
            notificarEstado(sala, `Mano terminada. Pasa la mano a: ${nuevoMano?.nombre || `Asiento ${sala.asientoMano + 1}`}.`);
            programarTimerSala(sala, () => {
              sala.recuentoEnCurso = false;
              iniciarMano(sala);
            }, 2000);
          }, 2000);
        }, sala.apuestasLances.pares.hayPares ? 2200 : 700);
      };

      if (sala.apuestasLances.pares.hayPares) {
        programarTimerSala(sala, () => {
          ordagoResuelto = resolverLanceEnRecuento(sala, 'pares');
          if (ordagoResuelto || comprobarVictoriaChico(sala)) {
            sala.recuentoEnCurso = false;
            return;
          }
          continuarConJuego();
        }, 2200);
      } else {
        continuarConJuego();
      }
    }, 2200);
  }, 1800);
}

function resolverLanceEnRecuento(sala, lance) {
  const info = sala.apuestasLances[lance];
  let ptsEnvite = info.puntos;

  // CASO 1: Lance resuelto en falso para GRANDE o CHICA
  if (info.resueltoEnFalso && (lance === 'grande' || lance === 'chica')) {
    const ptsFalso = info.puntosEnFalso || 1;
    const ganadoraFalso = info.ganadorEnFalso !== undefined ? info.ganadorEnFalso : 0;
    const nomGanadoraFalso = obtenerNombrePareja(sala, ganadoraFalso);
    const descFalso = info.descEnFalso || `Envite no querido (+${ptsFalso} pts)`;
    const resultado = evaluarGanadorLanceDetalle(sala, lance);

    const desgloseTexto = `${lance.toUpperCase()}: Cobrado en el lance por ${nomGanadoraFalso} (+${ptsFalso} pts: ${descFalso}). Mejor mano: ${resultado.nombreGanador}.`;

    const itemsCobro = [
      { desc: descFalso, pts: ptsFalso, jugador: nomGanadoraFalso },
      { desc: `Mejor mano (${resultado.motivo})`, pts: 0, jugador: resultado.nombreGanador }
    ];

    io.to(sala.id).emit('eventoLanceGanado', {
      lance: lance.toUpperCase(),
      asientoGanador: resultado.asientoGanador,
      parejaGanadora: ganadoraFalso,
      desglose: desgloseTexto,
      desgloseItems: itemsCobro,
      puntosActualizados: sala.puntos,
      esOrdagoDirecto: false
    });

    notificarEstado(sala, desgloseTexto);
    return false;
  }

  // CASO 2: PARES
  if (lance === 'pares') {
    let ganador;
    let nomGanador;
    let asientoGanador;
    let itemsCobro = [];
    let ptsPropios = 0;
    let desgloseTexto = "";

    if (info.resueltoEnFalso) {
      // Lance ganado en falso: el que no quiso renuncia al lance (el rival NO cobra nada)
      ganador = info.ganadorEnFalso !== undefined ? info.ganadorEnFalso : 0;
      nomGanador = obtenerNombrePareja(sala, ganador);
      const ptsFalso = info.puntosEnFalso || 1;
      const descFalso = info.descEnFalso || `Envite no querido (+${ptsFalso} pts)`;

      const a1 = ganador === 0 ? 0 : 1;
      const a2 = ganador === 0 ? 2 : 3;
      const p1 = evaluarDetallePares(sala.manos[a1]);
      const p2 = evaluarDetallePares(sala.manos[a2]);
      const cmp = compararManosPares(p1, p2);
      asientoGanador = (cmp > 0 || (cmp === 0 && distanciaMano(a1, sala.asientoMano) <= distanciaMano(a2, sala.asientoMano))) ? a1 : a2;

      const nom1 = Object.values(sala.jugadoresPorToken).find(p => p.asiento === a1)?.nombre || `Asiento ${a1+1}`;
      const nom2 = Object.values(sala.jugadoresPorToken).find(p => p.asiento === a2)?.nombre || `Asiento ${a2+1}`;

      itemsCobro.push({ desc: descFalso, pts: ptsFalso, jugador: nomGanador });
      if (p1.cobro > 0) {
        itemsCobro.push({ desc: p1.nombre, pts: p1.cobro, jugador: nom1 });
        ptsPropios += p1.cobro;
      }
      if (p2.cobro > 0) {
        itemsCobro.push({ desc: p2.nombre, pts: p2.cobro, jugador: nom2 });
        ptsPropios += p2.cobro;
      }

      // ptsFalso ya fue sumado al no querer; aquí solo se suman los pares propios ganados
      sala.puntos[ganador] += ptsPropios;

      desgloseTexto = `PARES: Cobrado en el lance por ${nomGanador} (+${ptsFalso} pts). Cobro de cartas propias: +${ptsPropios} pts para ${nomGanador}.`;
    } else {
      // Lance jugado de paso o con envite querido
      const resultado = evaluarGanadorLanceDetalle(sala, lance);
      ganador = resultado.parejaGanadora;
      nomGanador = obtenerNombrePareja(sala, ganador);
      asientoGanador = resultado.asientoGanador;

      const a1 = ganador === 0 ? 0 : 1;
      const a2 = ganador === 0 ? 2 : 3;
      const p1 = evaluarDetallePares(sala.manos[a1]);
      const p2 = evaluarDetallePares(sala.manos[a2]);
      const nom1 = Object.values(sala.jugadoresPorToken).find(p => p.asiento === a1)?.nombre || `Asiento ${a1+1}`;
      const nom2 = Object.values(sala.jugadoresPorToken).find(p => p.asiento === a2)?.nombre || `Asiento ${a2+1}`;

      let ptsEnviteSumar = 0;
      if (info.querido) {
        ptsEnviteSumar = info.puntos || 2;
        itemsCobro.push({ desc: `Envite querido`, pts: ptsEnviteSumar, jugador: nomGanador });
      }

      if (p1.cobro > 0) {
        itemsCobro.push({ desc: p1.nombre, pts: p1.cobro, jugador: nom1 });
        ptsPropios += p1.cobro;
      }
      if (p2.cobro > 0) {
        itemsCobro.push({ desc: p2.nombre, pts: p2.cobro, jugador: nom2 });
        ptsPropios += p2.cobro;
      }

      sala.puntos[ganador] += ptsPropios + ptsEnviteSumar;
      desgloseTexto = `${resultado.motivo}. +${ptsPropios + ptsEnviteSumar} pts para ${nomGanador} (${info.querido ? 'envite + pares' : 'pares'}).`;
    }

    io.to(sala.id).emit('eventoLanceGanado', {
      lance: "PARES",
      asientoGanador: asientoGanador,
      parejaGanadora: ganador,
      desglose: desgloseTexto,
      desgloseItems: itemsCobro,
      puntosActualizados: sala.puntos,
      esOrdagoDirecto: false
    });

    notificarEstado(sala, desgloseTexto);
    return false;
  }

  // CASO 3: JUEGO
  if (lance === 'juego') {
    let ganador;
    let nomGanador;
    let asientoGanador;
    let itemsCobro = [];
    let ptsPropios = 0;
    let desgloseTexto = "";

    const esAlPunto = !!info.esAlPunto;
    const nombreLanceTexto = esAlPunto ? "AL PUNTO" : "JUEGO";

    if (info.resueltoEnFalso) {
      // Lance ganado en falso: el rival que no quiso renuncia a todo (0 pts para el rival aunque tenga 31)
      ganador = info.ganadorEnFalso !== undefined ? info.ganadorEnFalso : 0;
      nomGanador = obtenerNombrePareja(sala, ganador);
      const ptsFalso = info.puntosEnFalso || 1;
      const descFalso = info.descEnFalso || `Envite no querido (+${ptsFalso} pts)`;

      const a1 = ganador === 0 ? 0 : 1;
      const a2 = ganador === 0 ? 2 : 3;
      const j1 = evaluarDetalleJuego(sala.manos[a1]);
      const j2 = evaluarDetalleJuego(sala.manos[a2]);
      const cmp = compararManosJuego(j1, j2);
      asientoGanador = (cmp > 0 || (cmp === 0 && distanciaMano(a1, sala.asientoMano) <= distanciaMano(a2, sala.asientoMano))) ? a1 : a2;

      const nom1 = Object.values(sala.jugadoresPorToken).find(p => p.asiento === a1)?.nombre || `Asiento ${a1+1}`;
      const nom2 = Object.values(sala.jugadoresPorToken).find(p => p.asiento === a2)?.nombre || `Asiento ${a2+1}`;

      itemsCobro.push({ desc: descFalso, pts: ptsFalso, jugador: nomGanador });

      if (!esAlPunto) {
        // En juego, solo la pareja ganadora cobra los tantos de su propio juego (si tienen)
        if (j1.tiene) {
          itemsCobro.push({ desc: j1.desc, pts: j1.cobro, jugador: nom1 });
          ptsPropios += j1.cobro;
        }
        if (j2.tiene) {
          itemsCobro.push({ desc: j2.desc, pts: j2.cobro, jugador: nom2 });
          ptsPropios += j2.cobro;
        }
      }

      // ptsFalso ya fue sumado al no querer; aquí solo se suman los tantos de cartas de la pareja ganadora
      sala.puntos[ganador] += ptsPropios;

      desgloseTexto = `${nombreLanceTexto}: Cobrado en el lance por ${nomGanador} (+${ptsFalso} pts). Cobro de cartas propias: +${ptsPropios} pts para ${nomGanador}. (El rival no quiso el envite y renuncia al tanteo).`;
    } else {
      // Lance jugado de paso o con envite querido
      const resultado = evaluarGanadorLanceDetalle(sala, lance);
      ganador = resultado.parejaGanadora;
      nomGanador = obtenerNombrePareja(sala, ganador);
      asientoGanador = resultado.asientoGanador;

      let ptsEnviteSumar = 0;
      if (info.querido) {
        ptsEnviteSumar = info.puntos || 2;
        itemsCobro.push({ desc: esAlPunto ? `Envite al punto` : `Envite de juego`, pts: ptsEnviteSumar, jugador: nomGanador });
      } else if (esAlPunto) {
        // Punto en paso da 1 punto a la mejor mano
        ptsEnviteSumar = 1;
        itemsCobro.push({ desc: `Punto ganado en paso`, pts: 1, jugador: resultado.nombreGanador });
      }

      if (esAlPunto) {
        if (info.querido) {
          itemsCobro.push({ desc: `Tanto de punto`, pts: 1, jugador: resultado.nombreGanador });
          ptsPropios = 1;
        }
      } else {
        const a1 = ganador === 0 ? 0 : 1;
        const a2 = ganador === 0 ? 2 : 3;
        const j1 = evaluarDetalleJuego(sala.manos[a1]);
        const j2 = evaluarDetalleJuego(sala.manos[a2]);
        const nom1 = Object.values(sala.jugadoresPorToken).find(p => p.asiento === a1)?.nombre || `Asiento ${a1+1}`;
        const nom2 = Object.values(sala.jugadoresPorToken).find(p => p.asiento === a2)?.nombre || `Asiento ${a2+1}`;

        if (j1.tiene) {
          itemsCobro.push({ desc: j1.desc, pts: j1.cobro, jugador: nom1 });
          ptsPropios += j1.cobro;
        }
        if (j2.tiene) {
          itemsCobro.push({ desc: j2.desc, pts: j2.cobro, jugador: nom2 });
          ptsPropios += j2.cobro;
        }
      }

      sala.puntos[ganador] += ptsPropios + ptsEnviteSumar;
      desgloseTexto = `${resultado.motivo}. +${ptsPropios + ptsEnviteSumar} pts para ${nomGanador} (${esAlPunto ? 'punto' : 'juego'}).`;
    }

    io.to(sala.id).emit('eventoLanceGanado', {
      lance: nombreLanceTexto,
      asientoGanador: asientoGanador,
      parejaGanadora: ganador,
      desglose: desgloseTexto,
      desgloseItems: itemsCobro,
      puntosActualizados: sala.puntos,
      esOrdagoDirecto: false
    });

    notificarEstado(sala, desgloseTexto);
    return false;
  }

  // CASO 4: GRANDE o CHICA normales (no resueltos en falso)
  const resultado = evaluarGanadorLanceDetalle(sala, lance);
  const ganador = resultado.parejaGanadora;
  const nomGanador = obtenerNombrePareja(sala, ganador);
  const asientoGanador = resultado.asientoGanador;
  let itemsCobro = [
    { desc: info.querido ? `Envite ganado` : `Paso ganado`, pts: ptsEnvite, jugador: nomGanador }
  ];
  sala.puntos[ganador] += ptsEnvite;
  const desgloseTexto = `${resultado.motivo}. +${ptsEnvite} pto(s) para ${nomGanador}.`;

  io.to(sala.id).emit('eventoLanceGanado', {
    lance: lance.toUpperCase(),
    asientoGanador: asientoGanador,
    parejaGanadora: ganador,
    desglose: desgloseTexto,
    desgloseItems: itemsCobro,
    puntosActualizados: sala.puntos,
    esOrdagoDirecto: false
  });

  notificarEstado(sala, desgloseTexto);
  return false;
}

function evaluarGanadorLanceDetalle(sala, lance) {
  let mejorAsiento = 0;

  for (let i = 1; i < 4; i++) {
    let cmp = 0;
    if (lance === 'grande') {
      cmp = compararManosGrande(sala.manos[i], sala.manos[mejorAsiento]);
    } else if (lance === 'chica') {
      cmp = compararManosChica(sala.manos[i], sala.manos[mejorAsiento]);
    } else if (lance === 'pares') {
      let pI = evaluarDetallePares(sala.manos[i]);
      let pMejor = evaluarDetallePares(sala.manos[mejorAsiento]);
      cmp = compararManosPares(pI, pMejor);
    } else if (lance === 'juego') {
      let jI = evaluarDetalleJuego(sala.manos[i]);
      let jMejor = evaluarDetalleJuego(sala.manos[mejorAsiento]);
      cmp = compararManosJuego(jI, jMejor);
    }

    if (cmp > 0) {
      mejorAsiento = i;
    } else if (cmp === 0) {
      if (distanciaMano(i, sala.asientoMano) < distanciaMano(mejorAsiento, sala.asientoMano)) {
        mejorAsiento = i;
      }
    }
  }

  const pareja = ASIENTOS_INFO[mejorAsiento].pareja;
  const nom = Object.values(sala.jugadoresPorToken).find(p => p.asiento === mejorAsiento)?.nombre || `Asiento ${mejorAsiento + 1}`;
  let motivo = "";

  if (lance === 'grande') {
    motivo = `Grande ganada por ${nom} (${formatearCartasMus(sala.manos[mejorAsiento], 'desc')})`;
  } else if (lance === 'chica') {
    motivo = `Chica ganada por ${nom} (${formatearCartasMus(sala.manos[mejorAsiento], 'asc')})`;
  } else if (lance === 'pares') {
    motivo = `Pares ganados por ${nom} (${evaluarDetallePares(sala.manos[mejorAsiento]).desc})`;
  } else if (lance === 'juego') {
    motivo = `Juego ganado por ${nom} (${evaluarDetalleJuego(sala.manos[mejorAsiento]).desc})`;
  }

  return { parejaGanadora: pareja, asientoGanador: mejorAsiento, nombreGanador: nom, motivo };
}

function comprobarVictoriaChico(sala, ganadorForzado = null, motivo = "", esOrdago = false) {
  let ganador = null;
  if (esOrdago && ganadorForzado !== null) {
    ganador = ganadorForzado;
  } else {
    if (sala.puntos[0] >= 40) ganador = 0;
    else if (sala.puntos[1] >= 40) ganador = 1;
  }

  if (ganador !== null) {
    limpiarTodosLosTimers(sala);
    sala.recuentoEnCurso = false;

    sala.chicosGanados[ganador] += 1;
    const nomGanador = obtenerNombrePareja(sala, ganador);
    let msgFinal = esOrdago ? motivo : `¡${nomGanador} alcanza 40 puntos y gana el Chico! Chicos: ${sala.chicosGanados[0]} - ${sala.chicosGanados[1]}`;

    let vacaGanada = false;
    if (sala.chicosGanados[ganador] >= 3) {
      sala.vacasGanadas[ganador] += 1;
      sala.chicosGanados = { 0: 0, 1: 0 };
      vacaGanada = true;
      msgFinal = `🏆 ¡¡VICTORIA TOTAL!! ${nomGanador} gana 3 Chicos y se lleva LA VACA del torneo.`;
    }

    // Registrar victorias y estadísticas en el Leaderboard global
    for (const tok in sala.jugadoresPorToken) {
      const jug = sala.jugadoresPorToken[tok];
      if (jug && !jug.esBot) {
        if (ASIENTOS_INFO[jug.asiento].pareja === ganador) {
          if (esOrdago) {
            registrarVictoriaLeaderboard(tok, jug.nombre, jug.avatar, 'ordago');
          }
          registrarVictoriaLeaderboard(tok, jug.nombre, jug.avatar, vacaGanada ? 'vaca' : 'chico');
        } else {
          registrarVictoriaLeaderboard(tok, jug.nombre, jug.avatar, 'derrota');
        }
      }
    }

    sala.puntos = { 0: 0, 1: 0 };
    sala.asientoMano = (sala.asientoMano + 1) % 4;

    io.to(sala.id).emit('victoriaChico', {
      ganadorPareja: ganador,
      nombreGanador: nomGanador,
      mensaje: msgFinal,
      chicosGanados: sala.chicosGanados,
      vacasGanadas: sala.vacasGanadas,
      esVaca: vacaGanada
    });

    notificarEstado(sala, msgFinal);
    programarTimerSala(sala, () => iniciarMano(sala), 4000);
    return true;
  }
  return false;
}

function ejecutarResetAdmin(sala) {
  limpiarTodosLosTimers(sala);
  sala.recuentoEnCurso = false;
  sala.jugadoresPorToken = {};
  sala.nombresParejas = { 0: 'Pareja 1', 1: 'Pareja 2' };
  sala.enPartida = false;
  sala.mazo = [];
  sala.descartes = [];
  sala.puntos = { 0: 0, 1: 0 };
  sala.chicosGanados = { 0: 0, 1: 0 };
  sala.vacasGanadas = { 0: 0, 1: 0 };
  sala.fase = 'espera';
  sala.asientoMano = 0;
  sala.turno = 0;
  sala.ordenMusVotos = {};
  sala.declaraciones = { pares: {}, juego: {} };
  sala.apuestaActual = { total: 0, ultimoAumento: 0, ultimoApostador: null, ordago: false, enPaso: true };
  sala.decisionPareja = { activa: false, parejaVotante: null, votos: {}, tiempoRestante: 12, timerId: null };
  sala.apuestasLances = {
    grande: { querido: false, puntos: 1, ordago: false, resueltoEnFalso: false },
    chica: { querido: false, puntos: 1, ordago: false, resueltoEnFalso: false },
    pares: { querido: false, puntos: 1, ordago: false, resueltoEnFalso: false, hayPares: false },
    juego: { querido: false, puntos: 1, ordago: false, resueltoEnFalso: false, esAlPunto: false }
  };
  emitirActualizacionAsientos(sala);
  notificarEstado(sala, "Mesa reseteada por administrador.");
  io.to(sala.id).emit('resetCompleto');
}

io.on('connection', (socket) => {
  let miSalaId = "principal";
  let miToken = null;

  socket.on('entrarSala', ({ salaId, token }) => {
    miSalaId = (salaId && salaId.trim() !== "") ? salaId.trim().toLowerCase() : "principal";
    miToken = token;
    socket.join(miSalaId);

    const sala = obtenerOCrearSala(miSalaId);

    if (miToken && sala.jugadoresPorToken[miToken]) {
      const j = sala.jugadoresPorToken[miToken];
      j.socketId = socket.id;
      socket.emit('asientoAsignado', {
        asiento: j.asiento,
        info: j,
        salaId: miSalaId,
        nombresParejas: sala.nombresParejas || { 0: 'Pareja 1', 1: 'Pareja 2' }
      });
      if (sala.enPartida) {
        socket.emit('misCartas', sala.manos[j.asiento] || []);
      }
      emitirActualizacionAsientos(sala);
      notificarEstado(sala, `${j.nombre} conectado.`);
      return;
    }

    socket.emit('asientosEstado', {
      asientos: obtenerEstadoAsientos(sala),
      nombresParejas: sala.nombresParejas || { 0: 'Pareja 1', 1: 'Pareja 2' }
    });
    socket.emit('leaderboardActualizado', obtenerListaLeaderboard());
  });

  socket.on('obtenerLeaderboard', () => {
    socket.emit('leaderboardActualizado', obtenerListaLeaderboard());
  });

  socket.on('pedirMisCartas', () => {
    const sala = obtenerOCrearSala(miSalaId);
    if (miToken && sala.jugadoresPorToken[miToken]) {
      const j = sala.jugadoresPorToken[miToken];
      j.socketId = socket.id;
      socket.emit('misCartas', sala.manos[j.asiento] || []);
    }
  });

  socket.on('unirseAsiento', ({ nombre, nombrePareja, asientoElegido, salaId, token, avatar }) => {
    const sId = (salaId && salaId.trim() !== "") ? salaId.trim().toLowerCase() : miSalaId;
    const sala = obtenerOCrearSala(sId);
    miToken = token;

    const ocupado = Object.values(sala.jugadoresPorToken).some(j => j.asiento === asientoElegido);
    if (ocupado) {
      socket.emit('errorAsiento', "Ese asiento ya está ocupado. Elige otro.");
      return;
    }

    const aInfo = ASIENTOS_INFO[asientoElegido];
    const nombreFinal = (nombre && nombre.trim() !== '') ? nombre.trim().slice(0, 14) : `Jugador ${asientoElegido + 1}`;
    const avatarFinal = (avatar && typeof avatar === 'string') ? avatar.slice(0, 6) : '👑';

    if (nombrePareja && typeof nombrePareja === 'string' && nombrePareja.trim() !== '') {
      sala.nombresParejas[aInfo.pareja] = nombrePareja.trim().slice(0, 20);
    }

    sala.jugadoresPorToken[miToken] = {
      asiento: asientoElegido,
      nombre: nombreFinal,
      avatar: avatarFinal,
      pareja: aInfo.pareja,
      esBot: false,
      socketId: socket.id
    };

    // Actualizar nombre y avatar actuales en la tabla leaderboard
    actualizarJugadorEnLeaderboard(miToken, nombreFinal, avatarFinal);
    io.emit('leaderboardActualizado', obtenerListaLeaderboard());

    socket.emit('asientoAsignado', {
      asiento: asientoElegido,
      info: sala.jugadoresPorToken[miToken],
      salaId: sId,
      nombresParejas: sala.nombresParejas
    });
    if (sala.enPartida) {
      socket.emit('misCartas', sala.manos[asientoElegido] || []);
    }

    emitirActualizacionAsientos(sala);
    notificarEstado(sala, `${avatarFinal} ${nombreFinal} se sentó en ${aInfo.nombreDef} (${obtenerNombrePareja(sala, aInfo.pareja)}).`);

    if (Object.keys(sala.jugadoresPorToken).length === 4 && !sala.enPartida) {
      iniciarMano(sala);
    }
  });

  socket.on('actualizarPerfil', ({ nombre, avatar }) => {
    const sala = obtenerOCrearSala(miSalaId);
    if (!miToken || !sala.jugadoresPorToken[miToken]) return;
    const j = sala.jugadoresPorToken[miToken];
    if (nombre && typeof nombre === 'string' && nombre.trim() !== '') {
      j.nombre = nombre.trim().slice(0, 14);
    }
    if (avatar && typeof avatar === 'string') {
      j.avatar = avatar.slice(0, 6);
    }
    actualizarJugadorEnLeaderboard(miToken, j.nombre, j.avatar);
    io.emit('leaderboardActualizado', obtenerListaLeaderboard());
    emitirActualizacionAsientos(sala);
    notificarEstado(sala, `${j.avatar || ''} ${j.nombre} actualizó su perfil.`);
  });

  socket.on('rellenarBots', () => {
    const sala = obtenerOCrearSala(miSalaId);
    let ocupados = Object.values(sala.jugadoresPorToken).map(j => j.asiento);

    if (!miToken || !sala.jugadoresPorToken[miToken]) {
      let primerLibre = [0, 1, 2, 3].find(a => !ocupados.includes(a));
      if (primerLibre !== undefined) {
        const aInfo = ASIENTOS_INFO[primerLibre];
        miToken = miToken || `user_${Date.now()}`;
        const nomDefecto = `Jugador ${primerLibre + 1}`;
        sala.jugadoresPorToken[miToken] = {
          asiento: primerLibre,
          nombre: nomDefecto,
          avatar: "👑",
          pareja: aInfo.pareja,
          esBot: false,
          socketId: socket.id
        };
        actualizarJugadorEnLeaderboard(miToken, nomDefecto, "👑");
        socket.emit('asientoAsignado', { asiento: primerLibre, info: sala.jugadoresPorToken[miToken], salaId: miSalaId });
      }
    }

    ocupados = Object.values(sala.jugadoresPorToken).map(j => j.asiento);
    [0, 1, 2, 3].forEach(a => {
      if (!ocupados.includes(a)) {
        const aInfo = ASIENTOS_INFO[a];
        const perfil = PERFILES_BOT_ASIENTOS[a % PERFILES_BOT_ASIENTOS.length];
        sala.jugadoresPorToken[`bot_${a}`] = {
          asiento: a,
          nombre: perfil.nombre,
          avatar: perfil.avatar,
          estilo: perfil.estilo,
          pareja: aInfo.pareja,
          esBot: true,
          socketId: null
        };
      }
    });

    emitirActualizacionAsientos(sala);
    notificarEstado(sala, "Mesa completada con Bots.");
    if (!sala.enPartida) iniciarMano(sala);
  });

  socket.on('enviarSena', ({ sena }) => {
    const sala = obtenerOCrearSala(miSalaId);
    if (!miToken || !sala.jugadoresPorToken[miToken]) return;
    const miAsiento = sala.jugadoresPorToken[miToken].asiento;
    const asientoCompanero = (miAsiento + 2) % 4;

    const companero = Object.values(sala.jugadoresPorToken).find(p => p.asiento === asientoCompanero);
    if (companero && companero.socketId) {
      io.to(companero.socketId).emit('senaRecibida', {
        deAsiento: miAsiento,
        deNombre: sala.jugadoresPorToken[miToken].nombre,
        sena: sena
      });
    }
  });

  socket.on('responderDeclaracion', ({ lleva }) => {
    const sala = obtenerOCrearSala(miSalaId);
    if (!miToken || !sala.jugadoresPorToken[miToken]) return;
    const j = sala.jugadoresPorToken[miToken];
    j.socketId = socket.id;
    if (sala.turno !== j.asiento) return;

    if (sala.fase === 'declaracion_pares') {
      const tienePares = evaluarDetallePares(sala.manos[j.asiento]).tipo > 0;
      if (lleva && !tienePares) {
        socket.emit('avisoNoPuedeHablar', { motivo: "No tienes pares en tu mano." });
        return;
      }
      procesarDeclaracionPares(sala, j.asiento, lleva);
    } else if (sala.fase === 'declaracion_juego') {
      const tieneJuego = evaluarDetalleJuego(sala.manos[j.asiento]).tiene;
      if (lleva && !tieneJuego) {
        socket.emit('avisoNoPuedeHablar', { motivo: "No tienes juego en tu mano." });
        return;
      }
      procesarDeclaracionJuego(sala, j.asiento, lleva);
    }
  });

  socket.on('solicitarResetAdmin', ({ password }) => {
    const sala = obtenerOCrearSala(miSalaId);
    if (password === ADMIN_PASSWORD) {
      ejecutarResetAdmin(sala);
    } else {
      socket.emit('errorAdminPassword', "Contraseña de administrador incorrecta.");
    }
  });

  socket.on('solicitarResetLeaderboard', ({ password }) => {
    if (password === ADMIN_PASSWORD) {
      leaderboard = {};
      guardarLeaderboard();
      io.emit('leaderboardActualizado', []);
      const sala = obtenerOCrearSala(miSalaId);
      notificarEstado(sala, "🏆 La tabla de clasificación ha sido reiniciada por el administrador.");
      io.to(sala.id).emit('mensajeChat', { asiento: -1, jugador: 'Admin', texto: '🏆 La tabla de clasificación y estadísticas ha sido reiniciada por el Administrador.' });
      socket.emit('avisoAdmin', "Tabla de clasificación y estadísticas reiniciada con éxito.");
    } else {
      socket.emit('errorAdminPassword', "Contraseña de administrador incorrecta.");
    }
  });

  socket.on('toggleModoLoco', ({ password }) => {
    const sala = obtenerOCrearSala(miSalaId);
    if (password === ADMIN_PASSWORD) {
      sala.modoLoco = !sala.modoLoco;
      if (sala.enPartida) {
        for (let i = 0; i < 4; i++) {
          sala.indicesCartaRevelada[i] = sala.modoLoco ? Math.floor(Math.random() * 4) : null;
        }
      }
      notificarEstado(sala, `Modo Loco ${sala.modoLoco ? 'ACTIVADO: ¡1 carta pública por persona!' : 'DESACTIVADO'}.`);
    } else {
      socket.emit('errorAdminPassword', "Contraseña de administrador incorrecta.");
    }
  });

  socket.on('votoMus', ({ quiereMus }) => {
    const sala = obtenerOCrearSala(miSalaId);
    if (!miToken || !sala.jugadoresPorToken[miToken]) return;
    const j = sala.jugadoresPorToken[miToken];
    j.socketId = socket.id;
    if (sala.fase !== 'mus' || sala.turno !== j.asiento) return;

    if (quiereMus) {
      sala.ordenMusVotos[j.asiento] = true;
      io.to(sala.id).emit('mensajeChat', { asiento: j.asiento, jugador: j.nombre, texto: "¡Mus!" });
      siguienteTurnoMus(sala);
    } else {
      io.to(sala.id).emit('mensajeChat', { asiento: j.asiento, jugador: j.nombre, texto: "¡No hay Mus!" });
      iniciarLance(sala, 'grande');
    }
  });

  socket.on('descartarCartas', (indices) => {
    const sala = obtenerOCrearSala(miSalaId);
    if (!miToken || !sala.jugadoresPorToken[miToken]) return;
    const j = sala.jugadoresPorToken[miToken];
    j.socketId = socket.id;
    if (sala.fase !== 'descartes') return;

    let mano = sala.manos[j.asiento] || [];
    let soltadas = 0;
    if (Array.isArray(indices)) {
      indices.sort((a,b) => b - a).forEach(idx => {
        if (idx >= 0 && idx < mano.length) {
          const c = mano.splice(idx, 1)[0];
          if (c) {
            sala.descartes.push(c);
            soltadas++;
          }
          mano.push(robarCarta(sala));
        }
      });
    }

    io.to(sala.id).emit('eventoDescarteAnim', {
      asiento: j.asiento,
      cantidad: soltadas
    });

    sala.ordenMusVotos[j.asiento] = 'listo';
    comprobarFinDescartes(sala);
  });

  socket.on('accionLance', (accion) => {
    const sala = obtenerOCrearSala(miSalaId);
    if (!miToken || !sala.jugadoresPorToken[miToken]) return;
    const j = sala.jugadoresPorToken[miToken];
    j.socketId = socket.id;

    if (!['grande', 'chica', 'pares', 'juego'].includes(sala.fase)) {
      return;
    }

    const infoLance = sala.apuestasLances[sala.fase];
    if (infoLance && (infoLance.querido || infoLance.resueltoEnFalso || infoLance.enPaso)) {
      socket.emit('avisoNoPuedeHablar', { motivo: `El lance de ${sala.fase.toUpperCase()} ya está resuelto.` });
      return;
    }

    if (!jugadorPuedeHablarEnLance(sala, j.asiento, sala.fase)) {
      socket.emit('avisoNoPuedeHablar', { motivo: sala.fase === 'pares' ? "No tienes pares" : "No tienes juego" });
      return;
    }

    const miPareja = ASIENTOS_INFO[j.asiento].pareja;

    if (sala.decisionPareja && sala.decisionPareja.activa) {
      if (miPareja === sala.decisionPareja.parejaVotante) {
        registrarVotoPareja(sala, j.asiento, accion);
      } else {
        socket.emit('avisoNoPuedeHablar', { motivo: "Debes esperar a que la pareja rival responda a la apuesta." });
      }
      return;
    }

    if (sala.turno !== j.asiento) {
      socket.emit('avisoNoPuedeHablar', { motivo: "No es tu turno de hablar." });
      return;
    }

    if (sala.apuestaActual.ultimoApostador === miPareja && !sala.apuestaActual.enPaso) {
      socket.emit('avisoNoPuedeHablar', { motivo: "Vuestro equipo ya ha apostado; debe responder la pareja rival." });
      return;
    }

    ejecutarAccionLance(sala, j, accion);
  });

  socket.on('disconnect', () => {
    const sala = salas[miSalaId];
    if (sala && miToken && sala.jugadoresPorToken[miToken]) {
      sala.jugadoresPorToken[miToken].socketId = null;
      notificarEstado(sala, `${sala.jugadoresPorToken[miToken].nombre} desconectado.`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`El Mus de Mario ejecutándose en el puerto ${PORT}`));
