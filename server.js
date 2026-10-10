const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const publicDir = fs.existsSync(path.join(__dirname, 'public')) ? path.join(__dirname, 'public') : __dirname;
app.use(express.static(publicDir));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

const ASIENTOS_INFO = [
  { id: 0, nombreDef: "Asiento 1", pareja: 0 },
  { id: 1, nombreDef: "Asiento 2", pareja: 1 },
  { id: 2, nombreDef: "Asiento 3", pareja: 0 },
  { id: 3, nombreDef: "Asiento 4", pareja: 1 }
];

let sala = {
  jugadores: {}, // socketId -> { asiento, nombre, pareja, esBot }
  enPartida: false,
  mazo: [],
  descartes: [],
  manos: { 0: [], 1: [], 2: [], 3: [] },
  puntos: { 0: 0, 1: 0 },
  juegosGanados: { 0: 0, 1: 0 }, // Contador global (Chicos ganados)
  fase: 'espera',
  asientoMano: 0,
  turno: 0,
  ordenMusVotos: {},
  apuestaActual: {
    total: 0,
    ultimoAumento: 0,
    ultimoApostador: null,
    ordago: false,
    enPaso: true
  },
  decisionPareja: {
    activa: false,
    parejaVotante: null,
    votos: {},
    tiempoRestante: 10,
    timerId: null
  },
  apuestasLances: {
    grande: { querido: false, puntos: 1, ordago: false, resueltoEnFalso: false },
    chica: { querido: false, puntos: 1, ordago: false, resueltoEnFalso: false },
    pares: { querido: false, puntos: 1, ordago: false, resueltoEnFalso: false, hayPares: false },
    juego: { querido: false, puntos: 1, ordago: false, resueltoEnFalso: false, esAlPunto: false }
  }
};

let botTurnoTimer = null;
let botDecisionTimers = [];

function limpiarTimersBots() {
  if (botTurnoTimer) {
    clearTimeout(botTurnoTimer);
    botTurnoTimer = null;
  }
  botDecisionTimers.forEach(t => clearTimeout(t));
  botDecisionTimers = [];
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

function robarCarta() {
  if (sala.mazo.length === 0) {
    if (sala.descartes.length > 0) {
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
  return sala.mazo.pop();
}

function evaluarFuerzaGrande(mano) {
  const vals = mano.map(c => c.valorMus).sort((a,b) => b - a);
  const reyes = vals.filter(v => v === 12).length;
  if (reyes >= 3) return 98;
  if (reyes === 2 && vals[2] >= 10) return 85;
  if (reyes === 2) return 72;
  if (reyes === 1 && vals[1] >= 11) return 55;
  if (reyes === 1) return 40;
  return 15;
}

function evaluarFuerzaChica(mano) {
  const vals = mano.map(c => c.valorMus).sort((a,b) => a - b);
  const ases = vals.filter(v => v === 1).length;
  if (ases >= 3) return 98;
  if (ases === 2 && vals[2] <= 5) return 82;
  if (ases === 2) return 68;
  if (ases === 1 && vals[1] <= 4) return 50;
  if (ases === 1) return 35;
  return 10;
}

function evaluarDetallePares(m) {
  let cnt = {};
  m.forEach(c => cnt[c.valorMus] = (cnt[c.valorMus] || 0) + 1);
  let paresVal = Object.keys(cnt).filter(k => cnt[k] >= 2).map(Number).sort((a,b) => b - a);
  let maxRep = Math.max(0, ...Object.values(cnt));

  if (maxRep === 4) return { tipo: 4, nombre: "Cuarteto", fuerza: 99, cobro: 3 };
  if (paresVal.length === 2) return { tipo: 3, nombre: "Duples", fuerza: paresVal[0] === 12 ? 95 : 80, cobro: 3 };
  if (maxRep === 3) return { tipo: 2, nombre: "Medias", fuerza: paresVal[0] === 12 ? 80 : 60, cobro: 2 };
  if (paresVal.length === 1) return { tipo: 1, nombre: "Pareja", fuerza: paresVal[0] === 12 ? 55 : 35, cobro: 1 };
  return { tipo: 0, nombre: "Sin pares", fuerza: 0, cobro: 0 };
}

function evaluarDetalleJuego(m) {
  let s = m.reduce((acc, c) => acc + c.valorJuego, 0);
  if (s >= 31) {
    if (s === 31) return { tiene: true, valor: 31, fuerza: 100, cobro: 3, desc: "La una (31)" };
    if (s === 32) return { tiene: true, valor: 32, fuerza: 88, cobro: 2, desc: "Juego de 32" };
    if (s === 40) return { tiene: true, valor: 40, fuerza: 75, cobro: 2, desc: "Juego de 40" };
    return { tiene: true, valor: s, fuerza: 65, cobro: 2, desc: `Juego de ${s}` };
  }
  return { tiene: false, valor: s, fuerza: s >= 29 ? 75 : 40, cobro: 1, desc: `Punto (${s})` };
}

function jugadorPuedeHablarEnLance(asiento, lance) {
  const mano = sala.manos[asiento];
  if (!mano || mano.length === 0) return false;
  if (lance === 'pares') return evaluarDetallePares(mano).tipo > 0;
  if (lance === 'juego') {
    if (sala.apuestasLances.juego.esAlPunto) return true;
    return evaluarDetalleJuego(mano).tiene;
  }
  return true;
}

function obtenerEstadoAsientos() {
  return ASIENTOS_INFO.map(a => {
    const j = Object.values(sala.jugadores).find(p => p.asiento === a.id);
    return { id: a.id, nombreDef: a.nombreDef, pareja: a.pareja, ocupado: !!j, ocupante: j?.nombre };
  });
}

function emitirActualizacionAsientos() {
  io.emit('asientosEstado', obtenerEstadoAsientos());
}

function iniciarMano() {
  limpiarTimersBots();
  limpiarTimerDecision();
  sala.mazo = crearMazo();
  sala.descartes = [];
  for (let i = 0; i < 4; i++) {
    sala.manos[i] = [];
    for (let c = 0; c < 4; c++) sala.manos[i].push(robarCarta());
  }
  sala.fase = 'mus';
  sala.turno = sala.asientoMano;
  sala.ordenMusVotos = {};
  sala.enPartida = true;
  sala.apuestasLances = {
    grande: { querido: false, puntos: 1, ordago: false, resueltoEnFalso: false },
    chica: { querido: false, puntos: 1, ordago: false, resueltoEnFalso: false },
    pares: { querido: false, puntos: 1, ordago: false, resueltoEnFalso: false, hayPares: false },
    juego: { querido: false, puntos: 1, ordago: false, resueltoEnFalso: false, esAlPunto: false }
  };
  const jMano = Object.values(sala.jugadores).find(p => p.asiento === sala.asientoMano);
  notificarEstado(`Nueva mano. Es Mano: ${jMano?.nombre || `Asiento ${sala.asientoMano + 1}`}.`);
  comprobarTurnoBot();
}

function notificarEstado(msg) {
  let permisosHabla = {};
  for (let a = 0; a < 4; a++) {
    permisosHabla[a] = jugadorPuedeHablarEnLance(a, sala.fase);
  }

  const revelarTodas = (sala.fase === 'recuento' || sala.fase === 'fin');

  io.emit('estadoJuego', {
    fase: sala.fase,
    turno: sala.turno,
    asientoMano: sala.asientoMano,
    puntos: sala.puntos,
    juegosGanados: sala.juegosGanados,
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
    jugadoresEnMesa: sala.jugadores,
    enPartida: sala.enPartida,
    todasLasManos: revelarTodas ? sala.manos : null
  });

  for (let socketId in sala.jugadores) {
    if (!sala.jugadores[socketId].esBot) {
      const asiento = sala.jugadores[socketId].asiento;
      io.to(socketId).emit('misCartas', sala.manos[asiento] || []);
    }
  }
}

function siguienteTurnoMus() {
  const votos = Object.keys(sala.ordenMusVotos);
  if (votos.length === 4) {
    sala.fase = 'descartes';
    notificarEstado("¡Hay Mus! A descartar cartas.");
    procesarDescartesBots();
  } else {
    sala.turno = (sala.asientoMano + votos.length) % 4;
    const j = Object.values(sala.jugadores).find(p => p.asiento === sala.turno);
    notificarEstado(`Turno de ${j?.nombre || 'Jugador'}: ¿Mus o Cortar?`);
    comprobarTurnoBot();
  }
}

function iniciarLance(nombreLance) {
  limpiarTimersBots();
  limpiarTimerDecision();
  sala.fase = nombreLance;
  sala.turno = sala.asientoMano;
  sala.apuestaActual = { total: 0, ultimoAumento: 0, ultimoApostador: null, ordago: false, enPaso: true };

  if (nombreLance === 'pares') {
    const p0 = evaluarDetallePares(sala.manos[0]).tipo > 0 || evaluarDetallePares(sala.manos[2]).tipo > 0;
    const p1 = evaluarDetallePares(sala.manos[1]).tipo > 0 || evaluarDetallePares(sala.manos[3]).tipo > 0;
    if (!p0 && !p1) {
      sala.apuestasLances.pares.hayPares = false;
      notificarEstado("Nadie tiene pares. Lance desierto.");
      setTimeout(() => avanzarSiguienteLance(), 1800);
      return;
    }
    if ((p0 && !p1) || (!p0 && p1)) {
      sala.apuestasLances.pares.hayPares = true;
      notificarEstado(`Solo Pareja ${p0 ? 1 : 2} lleva pares. No hay envite.`);
      setTimeout(() => avanzarSiguienteLance(), 1800);
      return;
    }
    sala.apuestasLances.pares.hayPares = true;
  }

  if (nombreLance === 'juego') {
    const j0 = evaluarDetalleJuego(sala.manos[0]).tiene || evaluarDetalleJuego(sala.manos[2]).tiene;
    const j1 = evaluarDetalleJuego(sala.manos[1]).tiene || evaluarDetalleJuego(sala.manos[3]).tiene;
    if (!j0 && !j1) {
      sala.apuestasLances.juego.esAlPunto = true;
      notificarEstado("Nadie tiene juego (31 o más). Se juega AL PUNTO.");
    } else if ((j0 && !j1) || (!j0 && j1)) {
      sala.apuestasLances.juego.esAlPunto = false;
      notificarEstado(`Solo Pareja ${j0 ? 1 : 2} lleva juego. No hay envite.`);
      setTimeout(() => avanzarSiguienteLance(), 1800);
      return;
    } else {
      sala.apuestasLances.juego.esAlPunto = false;
    }
  }

  verificarTurnoValidoLance();
}

function verificarTurnoValidoLance() {
  let vueltas = 0;
  while (!jugadorPuedeHablarEnLance(sala.turno, sala.fase) && vueltas < 4) {
    const jSaltado = Object.values(sala.jugadores).find(p => p.asiento === sala.turno);
    io.emit('mensajeChat', { asiento: sala.turno, jugador: jSaltado?.nombre || 'Jugador', texto: sala.fase === 'pares' ? "No llevo pares" : "No llevo juego" });
    sala.turno = (sala.turno + 1) % 4;
    vueltas++;
  }

  if (vueltas >= 4) {
    sala.apuestasLances[sala.fase].enPaso = true;
    notificarEstado(`Ronda de ${sala.fase.toUpperCase()} queda en paso.`);
    setTimeout(() => avanzarSiguienteLance(), 1500);
    return;
  }

  const jActual = Object.values(sala.jugadores).find(p => p.asiento === sala.turno);
  notificarEstado(`Ronda de ${sala.fase.toUpperCase()}. Habla ${jActual?.nombre || 'Jugador'}.`);
  comprobarTurnoBot();
}

function iniciarDecisionConjunta(parejaVotante) {
  limpiarTimersBots();
  limpiarTimerDecision();

  sala.decisionPareja = {
    activa: true,
    parejaVotante: parejaVotante,
    votos: {},
    tiempoRestante: 10,
    timerId: null
  };

  notificarEstado(`¡Envite! Pareja ${parejaVotante + 1} tiene 10s para decidir.`);

  for (let sId in sala.jugadores) {
    const j = sala.jugadores[sId];
    if (j.esBot && ASIENTOS_INFO[j.asiento].pareja === parejaVotante) {
      if (jugadorPuedeHablarEnLance(j.asiento, sala.fase)) {
        let t = setTimeout(() => {
          let votoBot = botCalcularRespuestaEnvite(j.asiento, sala.fase, sala.apuestaActual);
          registrarVotoPareja(j.asiento, votoBot);
        }, 1100);
        botDecisionTimers.push(t);
      } else {
        registrarVotoPareja(j.asiento, { tipo: 'noquiero', noPuedeHablar: true });
      }
    }
  }

  sala.decisionPareja.timerId = setInterval(() => {
    sala.decisionPareja.tiempoRestante--;
    io.emit('tickTimer', { tiempo: sala.decisionPareja.tiempoRestante });
    if (sala.decisionPareja.tiempoRestante <= 0) {
      finalizarDecisionPareja(true);
    }
  }, 1000);
}

function limpiarTimerDecision() {
  if (sala.decisionPareja && sala.decisionPareja.timerId) {
    clearInterval(sala.decisionPareja.timerId);
    sala.decisionPareja.timerId = null;
  }
  sala.decisionPareja.activa = false;
  sala.decisionPareja.votos = {};
}

function registrarVotoPareja(asiento, accion) {
  if (!sala.decisionPareja.activa) return;
  const parejaJugador = ASIENTOS_INFO[asiento].pareja;
  if (parejaJugador !== sala.decisionPareja.parejaVotante) return;

  sala.decisionPareja.votos[asiento] = accion;
  const j = Object.values(sala.jugadores).find(p => p.asiento === asiento);
  io.emit('votoParejaEmitido', { asiento, nombre: j?.nombre || 'Jugador', accion });

  const asientosPareja = ASIENTOS_INFO.filter(a => a.pareja === parejaJugador).map(a => a.id);
  const asientosHabilitados = asientosPareja.filter(a => jugadorPuedeHablarEnLance(a, sala.fase));

  const todosVotaron = asientosHabilitados.every(a => sala.decisionPareja.votos[a] !== undefined);
  if (todosVotaron) {
    finalizarDecisionPareja(false);
  }
}

function finalizarDecisionPareja(porTiempo) {
  if (!sala.decisionPareja.activa) return;
  limpiarTimersBots();
  const votos = { ...sala.decisionPareja.votos };
  const pareja = sala.decisionPareja.parejaVotante;
  limpiarTimerDecision();

  const listaAcciones = Object.values(votos);
  let decisionFinal = { tipo: 'noquiero' };

  if (listaAcciones.some(a => a.tipo === 'ordago')) {
    decisionFinal = { tipo: 'ordago' };
  } else if (listaAcciones.some(a => a.tipo === 'envidar')) {
    const maxAumento = Math.max(...listaAcciones.filter(a => a.tipo === 'envidar').map(a => a.cantidad || 2));
    decisionFinal = { tipo: 'envidar', cantidad: maxAumento };
  } else if (listaAcciones.some(a => a.tipo === 'quiero')) {
    decisionFinal = { tipo: 'quiero' };
  }

  if (decisionFinal.tipo === 'ordago') {
    sala.apuestaActual.ordago = true;
    sala.apuestaActual.ultimoApostador = pareja;
    sala.apuestaActual.enPaso = false;
    io.emit('mensajeChat', { asiento: -1, jugador: `Pareja ${pareja + 1}`, texto: "¡ÓRDAGO de réplica!" });
    iniciarDecisionConjunta(pareja === 0 ? 1 : 0);
  } else if (decisionFinal.tipo === 'envidar') {
    const aumento = decisionFinal.cantidad;
    sala.apuestaActual.total += aumento;
    sala.apuestaActual.ultimoAumento = aumento;
    sala.apuestaActual.ultimoApostador = pareja;
    sala.apuestaActual.enPaso = false;
    io.emit('mensajeChat', { asiento: -1, jugador: `Pareja ${pareja + 1}`, texto: `¡Re-envidado ${aumento} más! (Total: ${sala.apuestaActual.total})` });
    iniciarDecisionConjunta(pareja === 0 ? 1 : 0);
  } else if (decisionFinal.tipo === 'quiero') {
    io.emit('mensajeChat', { asiento: -1, jugador: `Pareja ${pareja + 1}`, texto: "¡QUIERO!" });
    sala.apuestasLances[sala.fase].querido = true;
    sala.apuestasLances[sala.fase].puntos = sala.apuestaActual.ordago ? 40 : sala.apuestaActual.total;
    sala.apuestasLances[sala.fase].ordago = sala.apuestaActual.ordago;
    notificarEstado(`¡Envite aceptado de ${sala.apuestaActual.ordago ? 'ÓRDAGO' : sala.apuestasLances[sala.fase].puntos + ' pts'}!`);
    setTimeout(() => avanzarSiguienteLance(), 1600);
  } else {
    io.emit('mensajeChat', { asiento: -1, jugador: `Pareja ${pareja + 1}`, texto: porTiempo ? "Tiempo: No quiero (Para ti)" : "No quiero (Para ti)" });
    let ptsGanados = 1;
    if (sala.apuestaActual.total > sala.apuestaActual.ultimoAumento) {
      ptsGanados = sala.apuestaActual.total - sala.apuestaActual.ultimoAumento;
    }
    sala.puntos[sala.apuestaActual.ultimoApostador] += ptsGanados;
    sala.apuestasLances[sala.fase].resueltoEnFalso = true;
    notificarEstado(`No querido. +${ptsGanados} punto(s) para Pareja ${sala.apuestaActual.ultimoApostador + 1}.`);
    if (comprobarVictoriaChico(sala.apuestaActual.ultimoApostador, `Alcanzados 40 puntos por envite rechazado`)) return;
    setTimeout(() => avanzarSiguienteLance(), 1600);
  }
}

function ejecutarAccionLance(jugador, { tipo, cantidad }) {
  const pareja = ASIENTOS_INFO[jugador.asiento].pareja;
  const parejaRival = pareja === 0 ? 1 : 0;

  if (tipo === 'paso') {
    io.emit('mensajeChat', { asiento: jugador.asiento, jugador: jugador.nombre, texto: "Paso" });
    sala.turno = (sala.turno + 1) % 4;
    if (sala.turno === sala.asientoMano) {
      sala.apuestasLances[sala.fase].enPaso = true;
      sala.apuestasLances[sala.fase].puntos = 1;
      notificarEstado(`Ronda de ${sala.fase.toUpperCase()} queda en paso.`);
      setTimeout(() => avanzarSiguienteLance(), 1500);
    } else {
      verificarTurnoValidoLance();
    }
  } else if (tipo === 'envidar') {
    const aumento = parseInt(cantidad) || 2;
    sala.apuestaActual.total += aumento;
    sala.apuestaActual.ultimoAumento = aumento;
    sala.apuestaActual.ultimoApostador = pareja;
    sala.apuestaActual.enPaso = false;

    const texto = sala.apuestaActual.total === aumento ? `¡Envido ${aumento}!` : `¡${aumento} más! (Total: ${sala.apuestaActual.total})`;
    io.emit('mensajeChat', { asiento: jugador.asiento, jugador: jugador.nombre, texto });
    iniciarDecisionConjunta(parejaRival);
  } else if (tipo === 'ordago') {
    sala.apuestaActual.ordago = true;
    sala.apuestaActual.ultimoApostador = pareja;
    sala.apuestaActual.enPaso = false;

    io.emit('mensajeChat', { asiento: jugador.asiento, jugador: jugador.nombre, texto: "¡ÓRDAGO!" });
    iniciarDecisionConjunta(parejaRival);
  }
}

function botCalcularAccionApertura(asiento, lance) {
  const mano = sala.manos[asiento];
  let fuerza = 0;
  if (lance === 'grande') fuerza = evaluarFuerzaGrande(mano);
  else if (lance === 'chica') fuerza = evaluarFuerzaChica(mano);
  else if (lance === 'pares') fuerza = evaluarDetallePares(mano).fuerza;
  else if (lance === 'juego') fuerza = evaluarDetalleJuego(mano).fuerza;

  if (fuerza >= 92) return Math.random() < 0.35 ? { tipo: 'envidar', cantidad: 5 } : { tipo: 'envidar', cantidad: 2 };
  if (fuerza >= 68) return { tipo: 'envidar', cantidad: 2 };
  return { tipo: 'paso' };
}

function botCalcularRespuestaEnvite(asiento, lance, apuestaActual) {
  const mano = sala.manos[asiento];
  let fuerza = 0;
  if (lance === 'grande') fuerza = evaluarFuerzaGrande(mano);
  else if (lance === 'chica') fuerza = evaluarFuerzaChica(mano);
  else if (lance === 'pares') fuerza = evaluarDetallePares(mano).fuerza;
  else if (lance === 'juego') fuerza = evaluarDetalleJuego(mano).fuerza;

  if (apuestaActual.ordago) return fuerza >= 95 ? { tipo: 'quiero' } : { tipo: 'noquiero' };
  if (fuerza >= 94 && apuestaActual.total <= 6) return { tipo: 'envidar', cantidad: 2 };
  if (apuestaActual.total <= 2 && fuerza >= 50) return { tipo: 'quiero' };
  if (apuestaActual.total <= 4 && fuerza >= 65) return { tipo: 'quiero' };
  if (apuestaActual.total <= 8 && fuerza >= 80) return { tipo: 'quiero' };
  return { tipo: 'noquiero' };
}

function comprobarTurnoBot() {
  if (botTurnoTimer) clearTimeout(botTurnoTimer);

  botTurnoTimer = setTimeout(() => {
    botTurnoTimer = null;
    if (sala.fase === 'mus') {
      const jActual = Object.values(sala.jugadores).find(j => j.asiento === sala.turno);
      if (jActual && jActual.esBot) {
        const mano = sala.manos[jActual.asiento];
        const j = evaluarDetalleJuego(mano);
        const p = evaluarDetallePares(mano);
        const g = evaluarFuerzaGrande(mano);
        const corta = (j.tiene && j.valor === 31) || p.tipo >= 3 || g >= 90;
        if (!corta) {
          sala.ordenMusVotos[jActual.asiento] = true;
          io.emit('mensajeChat', { asiento: jActual.asiento, jugador: jActual.nombre, texto: "¡Mus!" });
          siguienteTurnoMus();
        } else {
          io.emit('mensajeChat', { asiento: jActual.asiento, jugador: jActual.nombre, texto: "¡Corto! No hay mus" });
          iniciarLance('grande');
        }
      }
    } else if (['grande', 'chica', 'pares', 'juego'].includes(sala.fase)) {
      if (!sala.decisionPareja.activa) {
        const jActual = Object.values(sala.jugadores).find(j => j.asiento === sala.turno);
        if (jActual && jActual.esBot) {
          if (!jugadorPuedeHablarEnLance(jActual.asiento, sala.fase)) {
            ejecutarAccionLance(jActual, { tipo: 'paso' });
          } else {
            const accion = botCalcularAccionApertura(jActual.asiento, sala.fase);
            ejecutarAccionLance(jActual, accion);
          }
        }
      }
    }
  }, 950);
}

function procesarDescartesBots() {
  Object.values(sala.jugadores).filter(j => j.esBot).forEach(bot => {
    let mano = sala.manos[bot.asiento];
    sala.manos[bot.asiento] = mano.map(c => {
      if (c.valorMus >= 4 && c.valorMus <= 7) {
        sala.descartes.push(c);
        return robarCarta();
      }
      return c;
    });
    sala.ordenMusVotos[bot.asiento] = 'listo';
  });
  comprobarFinDescartes();
}

function comprobarFinDescartes() {
  if (Object.values(sala.ordenMusVotos).filter(v => v === 'listo').length === 4) {
    sala.ordenMusVotos = {};
    sala.fase = 'mus';
    sala.turno = sala.asientoMano;
    notificarEstado("Todos descartados. Se vuelve a preguntar Mus.");
    comprobarTurnoBot();
  }
}

function avanzarSiguienteLance() {
  const lances = ['grande', 'chica', 'pares', 'juego'];
  let idx = lances.indexOf(sala.fase);
  if (idx !== -1 && idx < lances.length - 1) {
    iniciarLance(lances[idx + 1]);
  } else {
    ejecutarRecuentoFinalMano();
  }
}

/* ========================================================
   RECUENTO FINAL, ÓRDAGO Y REGLAMENTO OFICIAL DE COBRO
======================================================== */

function ejecutarRecuentoFinalMano() {
  limpiarTimersBots();
  sala.fase = 'recuento';
  notificarEstado("¡A enseñar cartas! Volteando las manos para el recuento...");

  setTimeout(() => {
    let ordagoResuelto = resolverLanceEnRecuento('grande');
    if (ordagoResuelto || comprobarVictoriaChico()) return;

    setTimeout(() => {
      ordagoResuelto = resolverLanceEnRecuento('chica');
      if (ordagoResuelto || comprobarVictoriaChico()) return;

      setTimeout(() => {
        if (sala.apuestasLances.pares.hayPares) {
          ordagoResuelto = resolverLanceEnRecuento('pares');
          if (ordagoResuelto || comprobarVictoriaChico()) return;
        }

        setTimeout(() => {
          ordagoResuelto = resolverLanceEnRecuento('juego');
          if (ordagoResuelto || comprobarVictoriaChico()) return;

          setTimeout(() => {
            sala.asientoMano = (sala.asientoMano + 1) % 4;
            const nuevoMano = Object.values(sala.jugadores).find(p => p.asiento === sala.asientoMano);
            notificarEstado(`Mano terminada. Pasa la mano a: ${nuevoMano?.nombre || `Asiento ${sala.asientoMano + 1}`}.`);
            setTimeout(iniciarMano, 3000);
          }, 3500);
        }, 3500);
      }, 3500);
    }, 3500);
  }, 2200);
}

function resolverLanceEnRecuento(lance) {
  const info = sala.apuestasLances[lance];
  if (info.resueltoEnFalso) return false;

  const resultado = evaluarGanadorLanceDetalle(lance);
  const ganador = resultado.parejaGanadora;
  const asientoGanador = resultado.asientoGanador;

  // CASO ESPECIAL: ÓRDAGO QUERIDO
  if (info.ordago && info.querido) {
    let motivoOrdago = `¡ÓRDAGO GANADO EN ${lance.toUpperCase()} por ${resultado.nombreGanador}! Se lleva el juego completo.`;
    io.emit('eventoLanceGanado', {
      lance: lance.toUpperCase(),
      asientoGanador: asientoGanador,
      parejaGanadora: ganador,
      desglose: motivoOrdago,
      desgloseItems: [{ desc: "Órdago querido", pts: 40, jugador: resultado.nombreGanador }],
      puntosActualizados: sala.puntos,
      esOrdagoDirecto: true
    });
    notificarEstado(motivoOrdago);
    comprobarVictoriaChico(ganador, motivoOrdago, true);
    return true; // Termina la mano inmediatamente
  }

  let ptsEnvite = info.puntos;
  let itemsCobro = [];
  let ptsPropios = 0;
  let desgloseTexto = "";

  if (lance === 'pares') {
    // Cobro oficial para cada miembro de la pareja ganadora
    const a1 = ganador === 0 ? 0 : 1;
    const a2 = ganador === 0 ? 2 : 3;
    const p1 = evaluarDetallePares(sala.manos[a1]);
    const p2 = evaluarDetallePares(sala.manos[a2]);
    const nom1 = Object.values(sala.jugadores).find(p => p.asiento === a1)?.nombre || `Asiento ${a1+1}`;
    const nom2 = Object.values(sala.jugadores).find(p => p.asiento === a2)?.nombre || `Asiento ${a2+1}`;

    if (info.querido || ptsEnvite > 1) {
      itemsCobro.push({ desc: `Envite ganado`, pts: ptsEnvite, jugador: `Pareja ${ganador+1}` });
    } else {
      itemsCobro.push({ desc: `Paso ganado`, pts: 1, jugador: `Pareja ${ganador+1}` });
      ptsEnvite = 1;
    }

    if (p1.cobro > 0) itemsCobro.push({ desc: `${p1.nombre}`, pts: p1.cobro, jugador: nom1 });
    if (p2.cobro > 0) itemsCobro.push({ desc: `${p2.nombre}`, pts: p2.cobro, jugador: nom2 });

    ptsPropios = p1.cobro + p2.cobro;
    const totalPuntos = ptsEnvite + ptsPropios;
    sala.puntos[ganador] += totalPuntos;
    desgloseTexto = `${resultado.motivo}. Cobro: ${ptsEnvite} del lance + ${ptsPropios} de pares = +${totalPuntos} pts.`;
  } else if (lance === 'juego') {
    if (info.esAlPunto) {
      if (info.querido || ptsEnvite > 1) {
        itemsCobro.push({ desc: `Envite al punto`, pts: ptsEnvite, jugador: `Pareja ${ganador+1}` });
      } else {
        itemsCobro.push({ desc: `Punto ganado`, pts: 1, jugador: `Pareja ${ganador+1}` });
        ptsEnvite = 1;
      }
      itemsCobro.push({ desc: `Tanto de punto`, pts: 1, jugador: resultado.nombreGanador });
      ptsPropios = 1;
      const totalPuntos = ptsEnvite + ptsPropios;
      sala.puntos[ganador] += totalPuntos;
      desgloseTexto = `${resultado.motivo}. Cobro: ${ptsEnvite} del lance + 1 de punto = +${totalPuntos} pts.`;
    } else {
      const a1 = ganador === 0 ? 0 : 1;
      const a2 = ganador === 0 ? 2 : 3;
      const j1 = evaluarDetalleJuego(sala.manos[a1]);
      const j2 = evaluarDetalleJuego(sala.manos[a2]);
      const nom1 = Object.values(sala.jugadores).find(p => p.asiento === a1)?.nombre || `Asiento ${a1+1}`;
      const nom2 = Object.values(sala.jugadores).find(p => p.asiento === a2)?.nombre || `Asiento ${a2+1}`;

      if (info.querido || ptsEnvite > 1) {
        itemsCobro.push({ desc: `Envite de juego`, pts: ptsEnvite, jugador: `Pareja ${ganador+1}` });
      } else {
        itemsCobro.push({ desc: `Juego en paso`, pts: 1, jugador: `Pareja ${ganador+1}` });
        ptsEnvite = 1;
      }

      if (j1.tiene) itemsCobro.push({ desc: `${j1.desc}`, pts: j1.cobro, jugador: nom1 });
      if (j2.tiene) itemsCobro.push({ desc: `${j2.desc}`, pts: j2.cobro, jugador: nom2 });

      ptsPropios = (j1.tiene ? j1.cobro : 0) + (j2.tiene ? j2.cobro : 0);
      const totalPuntos = ptsEnvite + ptsPropios;
      sala.puntos[ganador] += totalPuntos;
      desgloseTexto = `${resultado.motivo}. Cobro: ${ptsEnvite} del lance + ${ptsPropios} de juegos = +${totalPuntos} pts.`;
    }
  } else {
    itemsCobro.push({ desc: info.querido ? `Envite ganado` : `Paso ganado`, pts: ptsEnvite, jugador: `Pareja ${ganador+1}` });
    sala.puntos[ganador] += ptsEnvite;
    desgloseTexto = `${resultado.motivo}. +${ptsEnvite} pto(s) para Pareja ${ganador + 1}.`;
  }

  io.emit('eventoLanceGanado', {
    lance: lance.toUpperCase(),
    asientoGanador: asientoGanador,
    parejaGanadora: ganador,
    desglose: desgloseTexto,
    desgloseItems: itemsCobro,
    puntosActualizados: sala.puntos,
    esOrdagoDirecto: false
  });

  notificarEstado(desgloseTexto);
  return false;
}

function evaluarGanadorLanceDetalle(lance) {
  const mayorCarta = (m) => Math.max(...m.map(c => c.valorMus));
  const menorCarta = (m) => Math.min(...m.map(c => c.valorMus));

  function tieneMano(asientoA, asientoB) {
    let distA = (asientoA - sala.asientoMano + 4) % 4;
    let distB = (asientoB - sala.asientoMano + 4) % 4;
    return distA <= distB;
  }

  if (lance === 'grande') {
    let m = [mayorCarta(sala.manos[0]), mayorCarta(sala.manos[1]), mayorCarta(sala.manos[2]), mayorCarta(sala.manos[3])];
    let max0 = Math.max(m[0], m[2]), max1 = Math.max(m[1], m[3]);
    let a0 = m[0] >= m[2] ? 0 : 2;
    let a1 = m[1] >= m[3] ? 1 : 3;

    let pareja = max0 > max1 ? 0 : (max1 > max0 ? 1 : (tieneMano(a0, a1) ? 0 : 1));
    let asiento = pareja === 0 ? a0 : a1;
    const nom = Object.values(sala.jugadores).find(p => p.asiento === asiento)?.nombre || `Asiento ${asiento+1}`;
    return { parejaGanadora: pareja, asientoGanador: asiento, nombreGanador: nom, motivo: `Grande ganada por ${nom}` };
  }

  if (lance === 'chica') {
    let m = [menorCarta(sala.manos[0]), menorCarta(sala.manos[1]), menorCarta(sala.manos[2]), menorCarta(sala.manos[3])];
    let min0 = Math.min(m[0], m[2]), min1 = Math.min(m[1], m[3]);
    let a0 = m[0] <= m[2] ? 0 : 2;
    let a1 = m[1] <= m[3] ? 1 : 3;

    let pareja = min0 < min1 ? 0 : (min1 < min0 ? 1 : (tieneMano(a0, a1) ? 0 : 1));
    let asiento = pareja === 0 ? a0 : a1;
    const nom = Object.values(sala.jugadores).find(p => p.asiento === asiento)?.nombre || `Asiento ${asiento+1}`;
    return { parejaGanadora: pareja, asientoGanador: asiento, nombreGanador: nom, motivo: `Chica ganada por ${nom}` };
  }

  if (lance === 'pares') {
    let p = [evaluarDetallePares(sala.manos[0]), evaluarDetallePares(sala.manos[1]), evaluarDetallePares(sala.manos[2]), evaluarDetallePares(sala.manos[3])];
    let f0 = Math.max(p[0].fuerza, p[2].fuerza), f1 = Math.max(p[1].fuerza, p[3].fuerza);
    let a0 = p[0].fuerza >= p[2].fuerza ? 0 : 2;
    let a1 = p[1].fuerza >= p[3].fuerza ? 1 : 3;

    let pareja = f0 > f1 ? 0 : (f1 > f0 ? 1 : (tieneMano(a0, a1) ? 0 : 1));
    let asiento = pareja === 0 ? a0 : a1;
    let det = p[asiento];
    const nom = Object.values(sala.jugadores).find(p => p.asiento === asiento)?.nombre || `Asiento ${asiento+1}`;
    return { parejaGanadora: pareja, asientoGanador: asiento, nombreGanador: nom, motivo: `Pares ganados por ${nom} con ${det.nombre}` };
  }

  if (lance === 'juego') {
    let j = [evaluarDetalleJuego(sala.manos[0]), evaluarDetalleJuego(sala.manos[1]), evaluarDetalleJuego(sala.manos[2]), evaluarDetalleJuego(sala.manos[3])];
    let f0 = Math.max(j[0].fuerza, j[2].fuerza), f1 = Math.max(j[1].fuerza, j[3].fuerza);
    let a0 = j[0].fuerza >= j[2].fuerza ? 0 : 2;
    let a1 = j[1].fuerza >= j[3].fuerza ? 1 : 3;

    let pareja = f0 > f1 ? 0 : (f1 > f0 ? 1 : (tieneMano(a0, a1) ? 0 : 1));
    let asiento = pareja === 0 ? a0 : a1;
    let det = j[asiento];
    const nom = Object.values(sala.jugadores).find(p => p.asiento === asiento)?.nombre || `Asiento ${asiento+1}`;
    return { parejaGanadora: pareja, asientoGanador: asiento, nombreGanador: nom, motivo: `Juego ganado por ${nom} con ${det.desc}` };
  }
}

function comprobarVictoriaChico(ganadorForzado = null, motivo = "", esOrdago = false) {
  let ganador = ganadorForzado;
  if (ganador === null) {
    if (sala.puntos[0] >= 40) ganador = 0;
    else if (sala.puntos[1] >= 40) ganador = 1;
  }

  if (ganador !== null) {
    sala.juegosGanados[ganador] += 1;
    let msgFinal = esOrdago ? motivo : `¡Pareja ${ganador + 1} alcanza 40 puntos y gana el juego! Marcador de juegos: ${sala.juegosGanados[0]} - ${sala.juegosGanados[1]}`;
    
    // Reinicio de puntos a 0-0 pero conservando juegos globales
    sala.puntos = { 0: 0, 1: 0 };
    sala.asientoMano = (sala.asientoMano + 1) % 4;

    io.emit('victoriaChico', {
      ganadorPareja: ganador,
      mensaje: msgFinal,
      juegosGanados: sala.juegosGanados
    });

    notificarEstado(msgFinal);
    setTimeout(iniciarMano, 4000);
    return true;
  }
  return false;
}

// RESETEO GLOBAL DE ADMINISTRADOR
function ejecutarResetAdmin() {
  limpiarTimersBots();
  limpiarTimerDecision();
  sala = {
    jugadores: {},
    enPartida: false,
    mazo: [],
    descartes: [],
    manos: { 0: [], 1: [], 2: [], 3: [] },
    puntos: { 0: 0, 1: 0 },
    juegosGanados: { 0: 0, 1: 0 },
    fase: 'espera',
    asientoMano: 0,
    turno: 0,
    ordenMusVotos: {},
    apuestaActual: { total: 0, ultimoAumento: 0, ultimoApostador: null, ordago: false, enPaso: true },
    decisionPareja: { activa: false, parejaVotante: null, votos: {}, tiempoRestante: 10, timerId: null },
    apuestasLances: {
      grande: { querido: false, puntos: 1, ordago: false, resueltoEnFalso: false },
      chica: { querido: false, puntos: 1, ordago: false, resueltoEnFalso: false },
      pares: { querido: false, puntos: 1, ordago: false, resueltoEnFalso: false, hayPares: false },
      juego: { querido: false, puntos: 1, ordago: false, resueltoEnFalso: false, esAlPunto: false }
    }
  };
  emitirActualizacionAsientos();
  io.emit('resetCompleto');
}

io.on('connection', (socket) => {
  socket.emit('asientosEstado', obtenerEstadoAsientos());

  socket.on('unirseAsiento', ({ nombre, asientoElegido }) => {
    const ocupado = Object.values(sala.jugadores).some(j => j.asiento === asientoElegido);
    if (ocupado) {
      socket.emit('errorAsiento', "Ese asiento ya está ocupado. Elige otro.");
      return;
    }

    const aInfo = ASIENTOS_INFO[asientoElegido];
    const nombreFinal = (nombre && nombre.trim() !== '') ? nombre.trim() : `Jugador ${asientoElegido + 1}`;
    sala.jugadores[socket.id] = {
      asiento: asientoElegido,
      nombre: nombreFinal,
      pareja: aInfo.pareja,
      esBot: false
    };

    socket.emit('asientoAsignado', { asiento: asientoElegido, info: sala.jugadores[socket.id] });
    emitirActualizacionAsientos();
    notificarEstado(`${nombreFinal} se sentó en ${aInfo.nombreDef}.`);

    if (Object.keys(sala.jugadores).length === 4 && !sala.enPartida) {
      iniciarMano();
    }
  });

  socket.on('rellenarBots', () => {
    let ocupados = Object.values(sala.jugadores).map(j => j.asiento);
    if (!sala.jugadores[socket.id]) {
      let primerLibre = [0, 1, 2, 3].find(a => !ocupados.includes(a));
      if (primerLibre !== undefined) {
        const aInfo = ASIENTOS_INFO[primerLibre];
        sala.jugadores[socket.id] = {
          asiento: primerLibre,
          nombre: "Mario",
          pareja: aInfo.pareja,
          esBot: false
        };
        socket.emit('asientoAsignado', { asiento: primerLibre, info: sala.jugadores[socket.id] });
      }
    }

    ocupados = Object.values(sala.jugadores).map(j => j.asiento);
    [0, 1, 2, 3].forEach(a => {
      if (!ocupados.includes(a)) {
        const aInfo = ASIENTOS_INFO[a];
        sala.jugadores[`bot_${a}`] = {
          asiento: a,
          nombre: `🤖 Bot ${a + 1}`,
          pareja: aInfo.pareja,
          esBot: true
        };
      }
    });

    emitirActualizacionAsientos();
    notificarEstado("Mesa completada con Bots.");
    if (!sala.enPartida) iniciarMano();
  });

  socket.on('solicitarResetAdmin', ({ password }) => {
    if (password === ADMIN_PASSWORD) {
      ejecutarResetAdmin();
    } else {
      socket.emit('errorAdminPassword', "Contraseña de administrador incorrecta.");
    }
  });

  socket.on('votoMus', ({ quiereMus }) => {
    const j = sala.jugadores[socket.id];
    if (!j || sala.fase !== 'mus' || sala.turno !== j.asiento) return;
    if (quiereMus) {
      sala.ordenMusVotos[j.asiento] = true;
      io.emit('mensajeChat', { asiento: j.asiento, jugador: j.nombre, texto: "¡Mus!" });
      siguienteTurnoMus();
    } else {
      io.emit('mensajeChat', { asiento: j.asiento, jugador: j.nombre, texto: "¡No hay Mus!" });
      iniciarLance('grande');
    }
  });

  socket.on('descartarCartas', (indices) => {
    const j = sala.jugadores[socket.id];
    if (!j || sala.fase !== 'descartes') return;
    let mano = sala.manos[j.asiento];
    indices.sort((a,b) => b - a).forEach(idx => {
      const c = mano.splice(idx, 1)[0];
      if (c) sala.descartes.push(c);
      mano.push(robarCarta());
    });
    sala.ordenMusVotos[j.asiento] = 'listo';
    comprobarFinDescartes();
  });

  socket.on('accionLance', (accion) => {
    const j = sala.jugadores[socket.id];
    if (!j) return;
    if (!jugadorPuedeHablarEnLance(j.asiento, sala.fase)) {
      socket.emit('avisoNoPuedeHablar', { motivo: sala.fase === 'pares' ? "No tienes pares" : "No tienes juego" });
      return;
    }

    if (sala.decisionPareja.activa && ASIENTOS_INFO[j.asiento].pareja === sala.decisionPareja.parejaVotante) {
      registrarVotoPareja(j.asiento, accion);
    } else {
      ejecutarAccionLance(j, accion);
    }
  });

  socket.on('disconnect', () => {
    if (sala.jugadores[socket.id]) {
      const nom = sala.jugadores[socket.id].nombre;
      delete sala.jugadores[socket.id];
      sala.enPartida = false;
      sala.fase = 'espera';
      limpiarTimersBots();
      limpiarTimerDecision();
      emitirActualizacionAsientos();
      notificarEstado(`${nom} ha salido. Partida en pausa.`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`El Mus de Mario en http://localhost:${PORT}`));
