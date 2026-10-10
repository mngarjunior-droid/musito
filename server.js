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

const ASIENTOS_INFO = [
  { id: 0, nombreDef: "Asiento 1 (Mano)", rol: "Mano", pareja: 0 },
  { id: 1, nombreDef: "Asiento 2", rol: "Segundo", pareja: 1 },
  { id: 2, nombreDef: "Asiento 3", rol: "Tercero", pareja: 0 },
  { id: 3, nombreDef: "Asiento 4", rol: "Postre", pareja: 1 }
];

let sala = {
  jugadores: {}, // socketId -> { asiento, nombre, rol, pareja, esBot }
  enPartida: false,
  mazo: [],
  descartes: [],
  manos: { 0: [], 1: [], 2: [], 3: [] },
  puntos: { 0: 0, 1: 0 },
  fase: 'espera',
  turno: 0,
  ordenMusVotos: {},
  apuestaActual: {
    total: 0,
    ultimoAumento: 0,
    ultimoApostador: null,
    ordago: false,
    enPaso: true
  },
  // Sistema de votación conjunta de pareja
  decisionPareja: {
    activa: false,
    parejaVotante: null,
    votos: {}, // asiento -> accion { tipo, cantidad }
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
  let maxRep = Math.max(...Object.values(cnt));

  if (maxRep === 4) return { tipo: 4, fuerza: 99 };
  if (paresVal.length === 2) return { tipo: 3, fuerza: paresVal[0] === 12 ? 95 : 80 };
  if (maxRep === 3) return { tipo: 2, fuerza: paresVal[0] === 12 ? 80 : 60 };
  if (paresVal.length === 1) return { tipo: 1, fuerza: paresVal[0] === 12 ? 55 : 35 };
  return { tipo: 0, fuerza: 0 };
}

function evaluarDetalleJuego(m) {
  let s = m.reduce((acc, c) => acc + c.valorJuego, 0);
  if (s >= 31) {
    if (s === 31) return { tiene: true, valor: 31, fuerza: 100 };
    if (s === 32) return { tiene: true, valor: 32, fuerza: 88 };
    return { tiene: true, valor: s, fuerza: 70 };
  }
  return { tiene: false, valor: s, fuerza: s >= 29 ? 75 : 40 };
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

function iniciarMano() {
  sala.mazo = crearMazo();
  sala.descartes = [];
  limpiarTimerDecision();
  for (let i = 0; i < 4; i++) {
    sala.manos[i] = [];
    for (let c = 0; c < 4; c++) sala.manos[i].push(robarCarta());
  }
  sala.fase = 'mus';
  sala.turno = 0;
  sala.ordenMusVotos = {};
  sala.enPartida = true;
  sala.apuestasLances = {
    grande: { querido: false, puntos: 1, ordago: false, resueltoEnFalso: false },
    chica: { querido: false, puntos: 1, ordago: false, resueltoEnFalso: false },
    pares: { querido: false, puntos: 1, ordago: false, resueltoEnFalso: false, hayPares: false },
    juego: { querido: false, puntos: 1, ordago: false, resueltoEnFalso: false, esAlPunto: false }
  };
  notificarEstado("Nueva mano repartida. Ronda de Mus.");
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
    puntos: sala.puntos,
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
    asientosOcupados: Object.values(sala.jugadores).map(j => ({ asiento: j.asiento, nombre: j.nombre, esBot: j.esBot })),
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
    sala.turno = votos.length;
    const j = Object.values(sala.jugadores).find(p => p.asiento === sala.turno);
    notificarEstado(`Turno de ${j?.nombre || 'Jugador'}: ¿Mus o Cortar?`);
    comprobarTurnoBot();
  }
}

function iniciarLance(nombreLance) {
  sala.fase = nombreLance;
  sala.turno = 0;
  sala.apuestaActual = { total: 0, ultimoAumento: 0, ultimoApostador: null, ordago: false, enPaso: true };
  limpiarTimerDecision();

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
    io.emit('mensajeChat', { jugador: jSaltado?.nombre || 'Jugador', texto: sala.fase === 'pares' ? "No llevo pares" : "No llevo juego" });
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

/* ========================================================
   SISTEMA DE VOTACIÓN CONJUNTA DE PAREJA CON TEMPORIZADOR
======================================================== */

function iniciarDecisionConjunta(parejaVotante) {
  limpiarTimerDecision();
  sala.decisionPareja = {
    activa: true,
    parejaVotante: parejaVotante,
    votos: {},
    tiempoRestante: 10,
    timerId: null
  };

  notificarEstado(`¡Envite en la mesa! Pareja ${parejaVotante + 1} tiene 10s para decidir.`);

  // Auto-voto inmediato para bots que formen parte de esa pareja
  for (let sId in sala.jugadores) {
    const j = sala.jugadores[sId];
    if (j.esBot && ASIENTOS_INFO[j.asiento].pareja === parejaVotante) {
      if (jugadorPuedeHablarEnLance(j.asiento, sala.fase)) {
        setTimeout(() => {
          let votoBot = botCalcularRespuestaEnvite(j.asiento, sala.fase, sala.apuestaActual);
          registrarVotoPareja(j.asiento, votoBot);
        }, 1200);
      } else {
        sala.decisionPareja.votos[j.asiento] = { tipo: 'noquiero' };
      }
    }
  }

  sala.decisionPareja.timerId = setInterval(() => {
    sala.decisionPareja.tiempoRestante--;
    io.emit('tickTimer', { tiempo: sala.decisionPareja.tiempoRestante });
    if (sala.decisionPareja.tiempoRestante <= 0) {
      finalizarDecisionPareja(true); // Expirado por tiempo
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

  // Comprobar si ambos miembros con derecho a hablar ya han votado
  const asientosPareja = ASIENTOS_INFO.filter(a => a.pareja === parejaJugador).map(a => a.id);
  const asientosHabilitados = asientosPareja.filter(a => jugadorPuedeHablarEnLance(a, sala.fase));

  const todosVotaron = asientosHabilitados.every(a => sala.decisionPareja.votos[a] !== undefined);
  if (todosVotaron) {
    finalizarDecisionPareja(false);
  }
}

// REGLA DE PRIORIDAD OFICIAL DE MUS
function finalizarDecisionPareja(porTiempo) {
  if (!sala.decisionPareja.activa) return;
  const votos = sala.decisionPareja.votos;
  limpiarTimerDecision();

  const listaAcciones = Object.values(votos);

  // Jerarquía de prioridad: ÓRDAGO > SUBIR (2 o 5 más) > QUIERO > NO QUIERO
  let decisionFinal = { tipo: 'noquiero' };

  if (listaAcciones.some(a => a.tipo === 'ordago')) {
    decisionFinal = { tipo: 'ordago' };
  } else if (listaAcciones.some(a => a.tipo === 'envidar')) {
    const maxAumento = Math.max(...listaAcciones.filter(a => a.tipo === 'envidar').map(a => a.cantidad || 2));
    decisionFinal = { tipo: 'envidar', cantidad: maxAumento };
  } else if (listaAcciones.some(a => a.tipo === 'quiero')) {
    decisionFinal = { tipo: 'quiero' };
  }

  // Ejecutar resolución según la prioridad obtenida
  const pareja = sala.decisionPareja.parejaVotante;
  const jugadorRepresentante = Object.values(sala.jugadores).find(p => ASIENTOS_INFO[p.asiento].pareja === pareja) || { nombre: `Pareja ${pareja+1}` };

  if (decisionFinal.tipo === 'ordago') {
    sala.apuestaActual.ordago = true;
    sala.apuestaActual.ultimoApostador = pareja;
    sala.apuestaActual.enPaso = false;
    io.emit('mensajeChat', { jugador: `Pareja ${pareja + 1}`, texto: "¡ÓRDAGO de réplica!" });
    iniciarDecisionConjunta(pareja === 0 ? 1 : 0);
  } else if (decisionFinal.tipo === 'envidar') {
    const aumento = decisionFinal.cantidad;
    sala.apuestaActual.total += aumento;
    sala.apuestaActual.ultimoAumento = aumento;
    sala.apuestaActual.ultimoApostador = pareja;
    sala.apuestaActual.enPaso = false;
    io.emit('mensajeChat', { jugador: `Pareja ${pareja + 1}`, texto: `¡Re-envidado ${aumento} más! (Total: ${sala.apuestaActual.total})` });
    iniciarDecisionConjunta(pareja === 0 ? 1 : 0);
  } else if (decisionFinal.tipo === 'quiero') {
    io.emit('mensajeChat', { jugador: `Pareja ${pareja + 1}`, texto: "¡QUIERO! (Decisión de pareja)" });
    sala.apuestasLances[sala.fase].querido = true;
    sala.apuestasLances[sala.fase].puntos = sala.apuestaActual.ordago ? 40 : sala.apuestaActual.total;
    sala.apuestasLances[sala.fase].ordago = sala.apuestaActual.ordago;
    notificarEstado(`¡Envite aceptado de ${sala.apuestasLances[sala.fase].puntos} puntos! Se resuelve en el recuento.`);
    setTimeout(() => avanzarSiguienteLance(), 1600);
  } else {
    io.emit('mensajeChat', { jugador: `Pareja ${pareja + 1}`, texto: porTiempo ? "Tiempo agotado: No quiero (Para ti)" : "No quiero (Para ti)" });
    let ptsGanados = 1;
    if (sala.apuestaActual.total > sala.apuestaActual.ultimoAumento) {
      ptsGanados = sala.apuestaActual.total - sala.apuestaActual.ultimoAumento;
    }
    sala.puntos[sala.apuestaActual.ultimoApostador] += ptsGanados;
    sala.apuestasLances[sala.fase].resueltoEnFalso = true;
    notificarEstado(`No querido. +${ptsGanados} punto(s) para Pareja ${sala.apuestaActual.ultimoApostador + 1}.`);
    if (comprobarFinPartida()) return;
    setTimeout(() => avanzarSiguienteLance(), 1600);
  }
}

/* ========================================================
   ACCIONES NORMALES DE LANCES
======================================================== */

function ejecutarAccionLance(jugador, { tipo, cantidad }) {
  const pareja = ASIENTOS_INFO[jugador.asiento].pareja;
  const parejaRival = pareja === 0 ? 1 : 0;

  if (tipo === 'paso') {
    io.emit('mensajeChat', { jugador: jugador.nombre, texto: "Paso" });
    sala.turno = (sala.turno + 1) % 4;
    if (sala.turno === 0) {
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
    io.emit('mensajeChat', { jugador: jugador.nombre, texto });
    iniciarDecisionConjunta(parejaRival);
  } else if (tipo === 'ordago') {
    sala.apuestaActual.ordago = true;
    sala.apuestaActual.ultimoApostador = pareja;
    sala.apuestaActual.enPaso = false;

    io.emit('mensajeChat', { jugador: jugador.nombre, texto: "¡ÓRDAGO!" });
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
  setTimeout(() => {
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
          io.emit('mensajeChat', { jugador: jActual.nombre, texto: "¡Mus!" });
          siguienteTurnoMus();
        } else {
          io.emit('mensajeChat', { jugador: jActual.nombre, texto: "¡Corto! No hay mus" });
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
  }, 1000);
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
    sala.turno = 0;
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

function ejecutarRecuentoFinalMano() {
  sala.fase = 'recuento';
  notificarEstado("¡A enseñar cartas! Volteando las manos para el recuento...");

  setTimeout(() => {
    resolverLanceEnRecuento('grande');
    if (comprobarFinPartida()) return;

    setTimeout(() => {
      resolverLanceEnRecuento('chica');
      if (comprobarFinPartida()) return;

      setTimeout(() => {
        if (sala.apuestasLances.pares.hayPares) {
          resolverLanceEnRecuento('pares');
          if (comprobarFinPartida()) return;
        }

        setTimeout(() => {
          resolverLanceEnRecuento('juego');
          if (comprobarFinPartida()) return;

          setTimeout(() => {
            notificarEstado("Mano finalizada. Repartiendo siguiente...");
            setTimeout(iniciarMano, 3000);
          }, 3000);
        }, 2000);
      }, 2000);
    }, 2000);
  }, 2000);
}

function resolverLanceEnRecuento(lance) {
  const info = sala.apuestasLances[lance];
  if (info.resueltoEnFalso) return;

  let ganador = evaluarGanadorLance(lance);
  let pts = info.puntos;

  if (info.enPaso && lance === 'pares') {
    let pTipo = Math.max(
      evaluarDetallePares(sala.manos[0]).tipo,
      evaluarDetallePares(sala.manos[2]).tipo,
      evaluarDetallePares(sala.manos[1]).tipo,
      evaluarDetallePares(sala.manos[3]).tipo
    );
    pts = pTipo >= 3 ? 3 : (pTipo === 2 ? 2 : 1);
  } else if (info.enPaso && lance === 'juego') {
    pts = info.esAlPunto ? 1 : 2;
  }

  sala.puntos[ganador] += pts;
  notificarEstado(`Pareja ${ganador + 1} se lleva ${pts} punto(s) en ${lance.toUpperCase()}`);
}

function evaluarGanadorLance(lance) {
  const mayorCarta = (m) => Math.max(...m.map(c => c.valorMus));
  const menorCarta = (m) => Math.min(...m.map(c => c.valorMus));

  let p0 = Math.max(mayorCarta(sala.manos[0]), mayorCarta(sala.manos[2]));
  let p1 = Math.max(mayorCarta(sala.manos[1]), mayorCarta(sala.manos[3]));

  if (lance === 'chica') {
    p0 = Math.min(menorCarta(sala.manos[0]), menorCarta(sala.manos[2]));
    p1 = Math.min(menorCarta(sala.manos[1]), menorCarta(sala.manos[3]));
    return p0 <= p1 ? 0 : 1;
  } else if (lance === 'pares') {
    p0 = Math.max(evaluarDetallePares(sala.manos[0]).fuerza, evaluarDetallePares(sala.manos[2]).fuerza);
    p1 = Math.max(evaluarDetallePares(sala.manos[1]).fuerza, evaluarDetallePares(sala.manos[3]).fuerza);
    return p0 >= p1 ? 0 : 1;
  } else if (lance === 'juego') {
    let j0 = Math.max(evaluarDetalleJuego(sala.manos[0]).fuerza, evaluarDetalleJuego(sala.manos[2]).fuerza);
    let j1 = Math.max(evaluarDetalleJuego(sala.manos[1]).fuerza, evaluarDetalleJuego(sala.manos[3]).fuerza);
    return j0 >= j1 ? 0 : 1;
  }
  return p0 >= p1 ? 0 : 1;
}

function comprobarFinPartida() {
  if (sala.puntos[0] >= 40 || sala.puntos[1] >= 40) {
    sala.fase = 'fin';
    sala.enPartida = false;
    notificarEstado(`¡VICTORIA! Pareja ${sala.puntos[0] >= 40 ? 1 : 2} ha ganado la partida con 40 puntos.`);
    return true;
  }
  return false;
}

io.on('connection', (socket) => {
  // Enviar estado de asientos ocupados al entrar
  socket.emit('asientosEstado', ASIENTOS_INFO.map(a => {
    const j = Object.values(sala.jugadores).find(p => p.asiento === a.id);
    return { id: a.id, nombreDef: a.nombreDef, pareja: a.pareja, ocupado: !!j, ocupante: j?.nombre };
  }));

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
      rol: aInfo.rol,
      pareja: aInfo.pareja,
      esBot: false
    };

    socket.emit('asientoAsignado', { asiento: asientoElegido, info: sala.jugadores[socket.id] });
    notificarEstado(`${nombreFinal} se sentó en ${aInfo.nombreDef}.`);

    if (Object.keys(sala.jugadores).length === 4 && !sala.enPartida) {
      iniciarMano();
    }
  });

  socket.on('rellenarBots', () => {
    const ocupados = Object.values(sala.jugadores).map(j => j.asiento);
    [0, 1, 2, 3].forEach(a => {
      if (!ocupados.includes(a)) {
        const aInfo = ASIENTOS_INFO[a];
        sala.jugadores[`bot_${a}`] = {
          asiento: a,
          nombre: `🤖 Bot ${a + 1}`,
          rol: aInfo.rol,
          pareja: aInfo.pareja,
          esBot: true
        };
      }
    });
    notificarEstado("Mesa completada con Bots de nivel alto.");
    if (!sala.enPartida) iniciarMano();
  });

  socket.on('votoMus', ({ quiereMus }) => {
    const j = sala.jugadores[socket.id];
    if (!j || sala.fase !== 'mus' || sala.turno !== j.asiento) return;
    if (quiereMus) {
      sala.ordenMusVotos[j.asiento] = true;
      io.emit('mensajeChat', { jugador: j.nombre, texto: "¡Mus!" });
      siguienteTurnoMus();
    } else {
      io.emit('mensajeChat', { jugador: j.nombre, texto: "¡No hay Mus!" });
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

    // Si hay decisión de pareja activa, registrar voto conjunto
    if (sala.decisionPareja.activa && ASIENTOS_INFO[j.asiento].pareja === sala.decisionPareja.parejaVotante) {
      registrarVotoPareja(j.asiento, accion);
    } else {
      // Apertura de lance normal
      ejecutarAccionLance(j, accion);
    }
  });

  socket.on('disconnect', () => {
    if (sala.jugadores[socket.id]) {
      const nom = sala.jugadores[socket.id].nombre;
      delete sala.jugadores[socket.id];
      sala.enPartida = false;
      sala.fase = 'espera';
      limpiarTimerDecision();
      notificarEstado(`${nom} ha salido. Partida en pausa.`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`El Mus de Mario en http://localhost:${PORT}`));
