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
  { id: 0, nombreDef: "Asiento 1", rol: "Mano", pareja: 0 },
  { id: 1, nombreDef: "Asiento 2", rol: "Segundo", pareja: 1 },
  { id: 2, nombreDef: "Asiento 3", rol: "Tercero", pareja: 0 },
  { id: 3, nombreDef: "Asiento 4", rol: "Postre", pareja: 1 }
];

const salas = {};

function obtenerOCrearSala(idSala) {
  const sId = (idSala && idSala.trim() !== "") ? idSala.trim().toLowerCase() : "principal";
  if (!salas[sId]) {
    salas[sId] = {
      id: sId,
      jugadoresPorToken: {},
      enPartida: false,
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
      decisionPareja: { activa: false, parejaVotante: null, votos: {}, tiempoRestante: 10, timerId: null },
      apuestasLances: {
        grande: { querido: false, puntos: 1, ordago: false, resueltoEnFalso: false },
        chica: { querido: false, puntos: 1, ordago: false, resueltoEnFalso: false },
        pares: { querido: false, puntos: 1, ordago: false, resueltoEnFalso: false, hayPares: false },
        juego: { querido: false, puntos: 1, ordago: false, resueltoEnFalso: false, esAlPunto: false }
      },
      botTurnoTimer: null,
      botDecisionTimers: []
    };
  }
  return salas[sId];
}

function limpiarTimersBots(sala) {
  if (sala.botTurnoTimer) {
    clearTimeout(sala.botTurnoTimer);
    sala.botTurnoTimer = null;
  }
  sala.botDecisionTimers.forEach(t => clearTimeout(t));
  sala.botDecisionTimers = [];
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

  if (maxRep === 4) return { tipo: 4, nombre: "Cuarteto", fuerza: 99, cobro: 3, rey: paresVal[0] === 12 };
  if (paresVal.length === 2) return { tipo: 3, nombre: "Duples", fuerza: paresVal[0] === 12 ? 95 : 80, cobro: 3, rey: paresVal[0] === 12, segundo: paresVal[1] };
  if (maxRep === 3) return { tipo: 2, nombre: "Medias", fuerza: paresVal[0] === 12 ? 80 : 60, cobro: 2, rey: paresVal[0] === 12 };
  if (paresVal.length === 1) return { tipo: 1, nombre: "Pareja", fuerza: paresVal[0] === 12 ? 55 : 35, cobro: 1, rey: paresVal[0] === 12 };
  return { tipo: 0, nombre: "Sin pares", fuerza: 0, cobro: 0, rey: false };
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

function tieneManoRelativa(asiento, sala) {
  const miPareja = ASIENTOS_INFO[asiento].pareja;
  const rival1 = miPareja === 0 ? 1 : 0;
  const rival2 = miPareja === 0 ? 3 : 2;
  const distMia = (asiento - sala.asientoMano + 4) % 4;
  const distRival1 = (rival1 - sala.asientoMano + 4) % 4;
  const distRival2 = (rival2 - sala.asientoMano + 4) % 4;
  return distMia < Math.min(distRival1, distRival2);
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
    return { id: a.id, nombreDef: a.nombreDef, pareja: a.pareja, ocupado: !!j, ocupante: j?.nombre, esBot: j?.esBot };
  });
}

function emitirActualizacionAsientos(sala) {
  io.to(sala.id).emit('asientosEstado', obtenerEstadoAsientos(sala));
}

function iniciarMano(sala) {
  limpiarTimersBots(sala);
  limpiarTimerDecision(sala);
  sala.mazo = crearMazo();
  sala.descartes = [];
  for (let i = 0; i < 4; i++) {
    sala.manos[i] = [];
    for (let c = 0; c < 4; c++) sala.manos[i].push(robarCarta(sala));
  }
  sala.fase = 'mus';
  sala.turno = sala.asientoMano;
  sala.ordenMusVotos = {};
  sala.declaraciones = { pares: {}, juego: {} };
  sala.enPartida = true;
  sala.apuestasLances = {
    grande: { querido: false, puntos: 1, ordago: false, resueltoEnFalso: false },
    chica: { querido: false, puntos: 1, ordago: false, resueltoEnFalso: false },
    pares: { querido: false, puntos: 1, ordago: false, resueltoEnFalso: false, hayPares: false },
    juego: { querido: false, puntos: 1, ordago: false, resueltoEnFalso: false, esAlPunto: false }
  };
  const jMano = Object.values(sala.jugadoresPorToken).find(p => p.asiento === sala.asientoMano);
  notificarEstado(sala, `Nueva mano. Es Mano: ${jMano?.nombre || `Asiento ${sala.asientoMano + 1}`}.`);
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
    mapaJugadores[j.asiento] = { asiento: j.asiento, nombre: j.nombre, pareja: j.pareja, esBot: j.esBot };
  });

  io.to(sala.id).emit('estadoJuego', {
    fase: sala.fase,
    turno: sala.turno,
    asientoMano: sala.asientoMano,
    puntos: sala.puntos,
    chicosGanados: sala.chicosGanados,
    vacasGanadas: sala.vacasGanadas,
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
    todasLasManos: revelarTodas ? sala.manos : null
  });

  for (let token in sala.jugadoresPorToken) {
    const j = sala.jugadoresPorToken[token];
    if (!j.esBot && j.socketId) {
      io.to(j.socketId).emit('misCartas', sala.manos[j.asiento] || []);
    }
  }
}

function siguienteTurnoMus(sala) {
  const votos = Object.keys(sala.ordenMusVotos);
  if (votos.length === 4) {
    sala.fase = 'descartes';
    notificarEstado(sala, "¡Hay Mus! A descartar cartas.");
    procesarDescartesBots(sala);
  } else {
    sala.turno = (sala.asientoMano + votos.length) % 4;
    const j = Object.values(sala.jugadoresPorToken).find(p => p.asiento === sala.turno);
    notificarEstado(sala, `Turno de ${j?.nombre || 'Jugador'}: ¿Mus o Cortar?`);
    comprobarTurnoBot(sala);
  }
}

function iniciarLance(sala, nombreLance) {
  limpiarTimersBots(sala);
  limpiarTimerDecision(sala);

  if (nombreLance === 'pares') {
    sala.fase = 'declaracion_pares';
    sala.turno = sala.asientoMano;
    sala.declaraciones.pares = {};
    const jMano = Object.values(sala.jugadoresPorToken).find(p => p.asiento === sala.asientoMano);
    notificarEstado(sala, `Declaración de Pares: ¿Llevas pares, ${jMano?.nombre || 'Mano'}?`);
    comprobarTurnoDeclaracionBot(sala);
    return;
  }

  if (nombreLance === 'juego') {
    sala.fase = 'declaracion_juego';
    sala.turno = sala.asientoMano;
    sala.declaraciones.juego = {};
    const jMano = Object.values(sala.jugadoresPorToken).find(p => p.asiento === sala.asientoMano);
    notificarEstado(sala, `Declaración de Juego: ¿Llevas juego (31 o más), ${jMano?.nombre || 'Mano'}?`);
    comprobarTurnoDeclaracionBot(sala);
    return;
  }

  sala.fase = nombreLance;
  sala.turno = sala.asientoMano;
  sala.apuestaActual = { total: 0, ultimoAumento: 0, ultimoApostador: null, ordago: false, enPaso: true };
  verificarTurnoValidoLance(sala);
}

function comprobarTurnoDeclaracionBot(sala) {
  if (sala.botTurnoTimer) clearTimeout(sala.botTurnoTimer);
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
  }, 900);
}

function procesarDeclaracionPares(sala, asiento, lleva) {
  sala.declaraciones.pares[asiento] = lleva;
  const j = Object.values(sala.jugadoresPorToken).find(p => p.asiento === asiento);
  io.to(sala.id).emit('mensajeChat', { asiento, jugador: j?.nombre || 'Jugador', texto: lleva ? "¡Sí llevo pares!" : "No llevo pares" });

  const respondidos = Object.keys(sala.declaraciones.pares).length;
  if (respondidos < 4) {
    sala.turno = (sala.asientoMano + respondidos) % 4;
    const sig = Object.values(sala.jugadoresPorToken).find(p => p.asiento === sala.turno);
    notificarEstado(sala, `¿Llevas pares, ${sig?.nombre || 'Jugador'}?`);
    comprobarTurnoDeclaracionBot(sala);
  } else {
    const p0 = sala.declaraciones.pares[0] || sala.declaraciones.pares[2];
    const p1 = sala.declaraciones.pares[1] || sala.declaraciones.pares[3];

    if (!p0 && !p1) {
      sala.apuestasLances.pares.hayPares = false;
      notificarEstado(sala, "Nadie lleva pares en la mesa. Lance desierto.");
      setTimeout(() => avanzarSiguienteLance(sala), 1800);
    } else if (p0 && !p1) {
      sala.apuestasLances.pares.hayPares = true;
      notificarEstado(sala, "Solo Pareja 1 lleva pares. Se cobran directamente al recuento.");
      setTimeout(() => avanzarSiguienteLance(sala), 1800);
    } else if (!p0 && p1) {
      sala.apuestasLances.pares.hayPares = true;
      notificarEstado(sala, "Solo Pareja 2 lleva pares. Se cobran directamente al recuento.");
      setTimeout(() => avanzarSiguienteLance(sala), 1800);
    } else {
      sala.apuestasLances.pares.hayPares = true;
      sala.fase = 'pares';
      sala.turno = sala.asientoMano;
      sala.apuestaActual = { total: 0, ultimoAumento: 0, ultimoApostador: null, ordago: false, enPaso: true };
      verificarTurnoValidoLance(sala);
    }
  }
}

function procesarDeclaracionJuego(sala, asiento, lleva) {
  sala.declaraciones.juego[asiento] = lleva;
  const j = Object.values(sala.jugadoresPorToken).find(p => p.asiento === asiento);
  io.to(sala.id).emit('mensajeChat', { asiento, jugador: j?.nombre || 'Jugador', texto: lleva ? "¡Sí llevo juego!" : "No llevo juego" });

  const respondidos = Object.keys(sala.declaraciones.juego).length;
  if (respondidos < 4) {
    sala.turno = (sala.asientoMano + respondidos) % 4;
    const sig = Object.values(sala.jugadoresPorToken).find(p => p.asiento === sala.turno);
    notificarEstado(sala, `¿Llevas juego, ${sig?.nombre || 'Jugador'}?`);
    comprobarTurnoDeclaracionBot(sala);
  } else {
    const j0 = sala.declaraciones.juego[0] || sala.declaraciones.juego[2];
    const j1 = sala.declaraciones.juego[1] || sala.declaraciones.juego[3];

    if (!j0 && !j1) {
      sala.apuestasLances.juego.esAlPunto = true;
      sala.fase = 'juego';
      sala.turno = sala.asientoMano;
      sala.apuestaActual = { total: 0, ultimoAumento: 0, ultimoApostador: null, ordago: false, enPaso: true };
      notificarEstado(sala, "Nadie tiene juego. Se disputa la ronda AL PUNTO.");
      verificarTurnoValidoLance(sala);
    } else if (j0 && !j1) {
      sala.apuestasLances.juego.esAlPunto = false;
      notificarEstado(sala, "Solo Pareja 1 lleva juego. Se cobrará en el recuento sin lance.");
      setTimeout(() => avanzarSiguienteLance(sala), 1800);
    } else if (!j0 && j1) {
      sala.apuestasLances.juego.esAlPunto = false;
      notificarEstado(sala, "Solo Pareja 2 lleva juego. Se cobrará en el recuento sin lance.");
      setTimeout(() => avanzarSiguienteLance(sala), 1800);
    } else {
      sala.apuestasLances.juego.esAlPunto = false;
      sala.fase = 'juego';
      sala.turno = sala.asientoMano;
      sala.apuestaActual = { total: 0, ultimoAumento: 0, ultimoApostador: null, ordago: false, enPaso: true };
      verificarTurnoValidoLance(sala);
    }
  }
}

function verificarTurnoValidoLance(sala) {
  let vueltas = 0;
  while (!jugadorPuedeHablarEnLance(sala, sala.turno, sala.fase) && vueltas < 4) {
    const jSaltado = Object.values(sala.jugadoresPorToken).find(p => p.asiento === sala.turno);
    io.to(sala.id).emit('mensajeChat', { asiento: sala.turno, jugador: jSaltado?.nombre || 'Jugador', texto: sala.fase === 'pares' ? "No hablo (sin pares)" : "No hablo (sin juego)" });
    sala.turno = (sala.turno + 1) % 4;
    vueltas++;
  }

  if (vueltas >= 4) {
    sala.apuestasLances[sala.fase].enPaso = true;
    notificarEstado(sala, `Ronda de ${sala.fase.toUpperCase()} queda en paso.`);
    setTimeout(() => avanzarSiguienteLance(sala), 1500);
    return;
  }

  const jActual = Object.values(sala.jugadoresPorToken).find(p => p.asiento === sala.turno);
  notificarEstado(sala, `Ronda de ${sala.fase.toUpperCase()}. Habla ${jActual?.nombre || 'Jugador'}.`);
  comprobarTurnoBot(sala);
}

function iniciarDecisionConjunta(sala, parejaVotante) {
  limpiarTimersBots(sala);
  limpiarTimerDecision(sala);

  sala.decisionPareja = {
    activa: true,
    parejaVotante: parejaVotante,
    votos: {},
    tiempoRestante: 10,
    timerId: null
  };

  notificarEstado(sala, `¡Envite! Pareja ${parejaVotante + 1} tiene 10s para decidir.`);

  for (let token in sala.jugadoresPorToken) {
    const j = sala.jugadoresPorToken[token];
    if (j.esBot && ASIENTOS_INFO[j.asiento].pareja === parejaVotante) {
      if (jugadorPuedeHablarEnLance(sala, j.asiento, sala.fase)) {
        let t = setTimeout(() => {
          let votoBot = botCalcularRespuestaEnvite(sala, j.asiento, sala.fase, sala.apuestaActual);
          registrarVotoPareja(sala, j.asiento, votoBot);
        }, 1100);
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
  if (!sala.decisionPareja.activa) return;
  const parejaJugador = ASIENTOS_INFO[asiento].pareja;
  if (parejaJugador !== sala.decisionPareja.parejaVotante) return;

  sala.decisionPareja.votos[asiento] = accion;
  const j = Object.values(sala.jugadoresPorToken).find(p => p.asiento === asiento);
  io.to(sala.id).emit('votoParejaEmitido', { asiento, nombre: j?.nombre || 'Jugador', accion });

  const asientosPareja = ASIENTOS_INFO.filter(a => a.pareja === parejaJugador).map(a => a.id);
  const asientosHabilitados = asientosPareja.filter(a => jugadorPuedeHablarEnLance(sala, a, sala.fase));

  const todosVotaron = asientosHabilitados.every(a => sala.decisionPareja.votos[a] !== undefined);
  if (todosVotaron) {
    finalizarDecisionPareja(sala, false);
  }
}

function finalizarDecisionPareja(sala, porTiempo) {
  if (!sala.decisionPareja.activa) return;
  limpiarTimersBots(sala);
  const votos = { ...sala.decisionPareja.votos };
  const pareja = sala.decisionPareja.parejaVotante;
  const esOrdagoActivo = sala.apuestaActual.ordago;
  limpiarTimerDecision(sala);

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

  // REGLA CLAVE DE ÓRDAGO ACEPTADO: RESOLUCIÓN INMEDIATA CON ANIMACIÓN
  if (esOrdagoActivo && decisionFinal.tipo === 'quiero') {
    io.to(sala.id).emit('mensajeChat', { asiento: -1, jugador: `Pareja ${pareja + 1}`, texto: "¡QUIERO EL ÓRDAGO!" });
    resolverOrdagoInmediato(sala, sala.fase);
    return;
  }

  if (decisionFinal.tipo === 'ordago') {
    sala.apuestaActual.ordago = true;
    sala.apuestaActual.ultimoApostador = pareja;
    sala.apuestaActual.enPaso = false;
    io.to(sala.id).emit('mensajeChat', { asiento: -1, jugador: `Pareja ${pareja + 1}`, texto: "¡ÓRDAGO de réplica!" });
    iniciarDecisionConjunta(sala, pareja === 0 ? 1 : 0);
  } else if (decisionFinal.tipo === 'envidar') {
    const aumento = decisionFinal.cantidad;
    sala.apuestaActual.total += aumento;
    sala.apuestaActual.ultimoAumento = aumento;
    sala.apuestaActual.ultimoApostador = pareja;
    sala.apuestaActual.enPaso = false;
    io.to(sala.id).emit('mensajeChat', { asiento: -1, jugador: `Pareja ${pareja + 1}`, texto: `¡Re-envidado ${aumento} más! (Total: ${sala.apuestaActual.total})` });
    iniciarDecisionConjunta(sala, pareja === 0 ? 1 : 0);
  } else if (decisionFinal.tipo === 'quiero') {
    io.to(sala.id).emit('mensajeChat', { asiento: -1, jugador: `Pareja ${pareja + 1}`, texto: "¡QUIERO!" });
    sala.apuestasLances[sala.fase].querido = true;
    sala.apuestasLances[sala.fase].puntos = sala.apuestaActual.total;
    notificarEstado(sala, `¡Envite de ${sala.apuestasLances[sala.fase].puntos} pts aceptado! Se cobrará en el recuento.`);
    setTimeout(() => avanzarSiguienteLance(sala), 1600);
  } else {
    // Órdago o envite rechazado: NO se acaba la partida, solo se lleva los puntos y sigue el juego
    io.to(sala.id).emit('mensajeChat', { asiento: -1, jugador: `Pareja ${pareja + 1}`, texto: porTiempo ? "Tiempo: No quiero (Para ti)" : "No quiero (Para ti)" });
    let ptsGanados = 1;
    if (sala.apuestaActual.total > sala.apuestaActual.ultimoAumento) {
      ptsGanados = sala.apuestaActual.total - sala.apuestaActual.ultimoAumento;
    }
    sala.puntos[sala.apuestaActual.ultimoApostador] += ptsGanados;
    sala.apuestasLances[sala.fase].resueltoEnFalso = true;
    notificarEstado(sala, `Rechazado. +${ptsGanados} punto(s) para Pareja ${sala.apuestaActual.ultimoApostador + 1}.`);
    if (comprobarVictoriaChico(sala, sala.apuestaActual.ultimoApostador, `Alcanzados 40 puntos por envite rechazado`)) return;
    setTimeout(() => avanzarSiguienteLance(sala), 1600);
  }
}

function resolverOrdagoInmediato(sala, lance) {
  limpiarTimersBots(sala);
  limpiarTimerDecision(sala);
  sala.fase = 'recuento';

  // Mostrar mensaje y destapar de inmediato todas las cartas con animación 3D
  notificarEstado(sala, `¡ÓRDAGO ACEPTADO EN ${lance.toUpperCase()}! ¡A ver las cartas!`, true);

  setTimeout(() => {
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
  }, 2400);
}

function ejecutarAccionLance(sala, jugador, { tipo, cantidad }) {
  const pareja = ASIENTOS_INFO[jugador.asiento].pareja;
  const parejaRival = pareja === 0 ? 1 : 0;

  if (tipo === 'paso') {
    io.to(sala.id).emit('mensajeChat', { asiento: jugador.asiento, jugador: jugador.nombre, texto: "Paso" });
    sala.turno = (sala.turno + 1) % 4;
    if (sala.turno === sala.asientoMano) {
      sala.apuestasLances[sala.fase].enPaso = true;
      sala.apuestasLances[sala.fase].puntos = 1;
      notificarEstado(sala, `Ronda de ${sala.fase.toUpperCase()} queda en paso.`);
      setTimeout(() => avanzarSiguienteLance(sala), 1500);
    } else {
      verificarTurnoValidoLance(sala);
    }
  } else if (tipo === 'envidar') {
    const aumento = parseInt(cantidad) || 2;
    sala.apuestaActual.total += aumento;
    sala.apuestaActual.ultimoAumento = aumento;
    sala.apuestaActual.ultimoApostador = pareja;
    sala.apuestaActual.enPaso = false;

    const texto = sala.apuestaActual.total === aumento ? `¡Envido ${aumento}!` : `¡${aumento} más! (Total: ${sala.apuestaActual.total})`;
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

function botCalcularAccionApertura(sala, asiento, lance) {
  const mano = sala.manos[asiento];
  let fuerza = 0;
  if (lance === 'grande') fuerza = evaluarFuerzaGrande(mano);
  else if (lance === 'chica') fuerza = evaluarFuerzaChica(mano);
  else if (lance === 'pares') fuerza = evaluarDetallePares(mano).fuerza;
  else if (lance === 'juego') fuerza = evaluarDetalleJuego(mano).fuerza;

  // Un bot NUNCA abre tirando un órdago a lo loco
  if (fuerza >= 92) return Math.random() < 0.25 ? { tipo: 'envidar', cantidad: 5 } : { tipo: 'envidar', cantidad: 2 };
  if (fuerza >= 68) return { tipo: 'envidar', cantidad: 2 };
  return { tipo: 'paso' };
}

// IA PRUDENTE Y HUMANA ANTE ÓRDAGOS Y ENVIDES
function botCalcularRespuestaEnvite(sala, asiento, lance, apuestaActual) {
  const mano = sala.manos[asiento];
  const esMano = tieneManoRelativa(asiento, sala);

  // ANTE UN ÓRDAGO: El bot es muy prudente, "no se calienta"
  if (apuestaActual.ordago) {
    if (lance === 'grande') {
      const reyes = mano.filter(c => c.valorMus === 12).length;
      if (reyes === 4) return { tipo: 'quiero' }; // 4 Reyes es invencible
      if (reyes === 3) {
        const cuarta = mano.map(c => c.valorMus).sort((a,b) => b-a)[3];
        // Solo si tiene 3 Reyes con caballo o sota y además tiene la ventaja de Mano
        if (cuarta >= 10 && esMano) return { tipo: 'quiero' };
      }
      return { tipo: 'noquiero' }; // Con 2 reyes o menos JAMÁS ve un órdago
    }

    if (lance === 'chica') {
      const ases = mano.filter(c => c.valorMus === 1).length;
      if (ases === 4) return { tipo: 'quiero' };
      if (ases === 3 && esMano) return { tipo: 'quiero' };
      return { tipo: 'noquiero' };
    }

    if (lance === 'pares') {
      const p = evaluarDetallePares(mano);
      if (p.tipo === 4 && p.rey) return { tipo: 'quiero' }; // Cuarteto de reyes
      if (p.tipo === 3 && p.rey && p.segundo >= 11 && esMano) return { tipo: 'quiero' }; // Duples de Reyes y Caballos con mano
      return { tipo: 'noquiero' }; // Medias o duples corrientes NUNCA ven órdago
    }

    if (lance === 'juego') {
      const j = evaluarDetalleJuego(mano);
      // En Mus es regla de oro: solo se ve un órdago con 31 (La una)
      if (j.tiene && j.valor === 31) {
        if (esMano) return { tipo: 'quiero' }; // Insuperable
        return Math.random() < 0.85 ? { tipo: 'quiero' } : { tipo: 'noquiero' };
      }
      return { tipo: 'noquiero' }; // Con 32 o punto nunca ven órdago
    }

    return { tipo: 'noquiero' };
  }

  // ENVIDES NORMALES
  let fuerza = 0;
  if (lance === 'grande') fuerza = evaluarFuerzaGrande(mano);
  else if (lance === 'chica') fuerza = evaluarFuerzaChica(mano);
  else if (lance === 'pares') fuerza = evaluarDetallePares(mano).fuerza;
  else if (lance === 'juego') fuerza = evaluarDetalleJuego(mano).fuerza;

  if (fuerza >= 95 && apuestaActual.total <= 4) return { tipo: 'envidar', cantidad: 2 };
  if (apuestaActual.total <= 2 && fuerza >= 50) return { tipo: 'quiero' };
  if (apuestaActual.total <= 4 && fuerza >= 68) return { tipo: 'quiero' };
  if (apuestaActual.total <= 8 && fuerza >= 82) return { tipo: 'quiero' };
  return { tipo: 'noquiero' };
}

function comprobarTurnoBot(sala) {
  if (sala.botTurnoTimer) clearTimeout(sala.botTurnoTimer);

  sala.botTurnoTimer = setTimeout(() => {
    sala.botTurnoTimer = null;
    if (sala.fase === 'mus') {
      const jActual = Object.values(sala.jugadoresPorToken).find(j => j.asiento === sala.turno);
      if (jActual && jActual.esBot) {
        const mano = sala.manos[jActual.asiento];
        const j = evaluarDetalleJuego(mano);
        const p = evaluarDetallePares(mano);
        const g = evaluarFuerzaGrande(mano);
        const corta = (j.tiene && j.valor === 31) || p.tipo >= 3 || g >= 90;
        if (!corta) {
          sala.ordenMusVotos[jActual.asiento] = true;
          io.to(sala.id).emit('mensajeChat', { asiento: jActual.asiento, jugador: jActual.nombre, texto: "¡Mus!" });
          siguienteTurnoMus(sala);
        } else {
          io.to(sala.id).emit('mensajeChat', { asiento: jActual.asiento, jugador: jActual.nombre, texto: "¡Corto! No hay mus" });
          iniciarLance(sala, 'grande');
        }
      }
    } else if (['grande', 'chica', 'pares', 'juego'].includes(sala.fase)) {
      if (!sala.decisionPareja.activa) {
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
  }, 950);
}

function procesarDescartesBots(sala) {
  Object.values(sala.jugadoresPorToken).filter(j => j.esBot).forEach(bot => {
    let mano = sala.manos[bot.asiento];
    sala.manos[bot.asiento] = mano.map(c => {
      if (c.valorMus >= 4 && c.valorMus <= 7) {
        sala.descartes.push(c);
        return robarCarta(sala);
      }
      return c;
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
    notificarEstado(sala, "Todos descartados. Se vuelve a preguntar Mus.");
    comprobarTurnoBot(sala);
  }
}

function avanzarSiguienteLance(sala) {
  const lances = ['grande', 'chica', 'pares', 'juego'];
  let idx = lances.indexOf(sala.fase.replace('declaracion_', ''));
  if (idx !== -1 && idx < lances.length - 1) {
    iniciarLance(sala, lances[idx + 1]);
  } else {
    ejecutarRecuentoFinalMano(sala);
  }
}

function ejecutarRecuentoFinalMano(sala) {
  limpiarTimersBots(sala);
  sala.fase = 'recuento';
  notificarEstado(sala, "¡A enseñar cartas! Volteando las manos para el recuento...");

  setTimeout(() => {
    let ordagoResuelto = resolverLanceEnRecuento(sala, 'grande');
    if (ordagoResuelto || comprobarVictoriaChico(sala)) return;

    setTimeout(() => {
      ordagoResuelto = resolverLanceEnRecuento(sala, 'chica');
      if (ordagoResuelto || comprobarVictoriaChico(sala)) return;

      setTimeout(() => {
        if (sala.apuestasLances.pares.hayPares) {
          ordagoResuelto = resolverLanceEnRecuento(sala, 'pares');
          if (ordagoResuelto || comprobarVictoriaChico(sala)) return;
        }

        setTimeout(() => {
          ordagoResuelto = resolverLanceEnRecuento(sala, 'juego');
          if (ordagoResuelto || comprobarVictoriaChico(sala)) return;

          setTimeout(() => {
            sala.asientoMano = (sala.asientoMano + 1) % 4;
            const nuevoMano = Object.values(sala.jugadoresPorToken).find(p => p.asiento === sala.asientoMano);
            notificarEstado(sala, `Mano terminada. Pasa la mano a: ${nuevoMano?.nombre || `Asiento ${sala.asientoMano + 1}`}.`);
            setTimeout(() => iniciarMano(sala), 3000);
          }, 3500);
        }, 3500);
      }, 3500);
    }, 3500);
  }, 2200);
}

function resolverLanceEnRecuento(sala, lance) {
  const info = sala.apuestasLances[lance];
  if (info.resueltoEnFalso) return false;

  const resultado = evaluarGanadorLanceDetalle(sala, lance);
  const ganador = resultado.parejaGanadora;
  const asientoGanador = resultado.asientoGanador;

  let ptsEnvite = info.puntos;
  let itemsCobro = [];
  let ptsPropios = 0;
  let desgloseTexto = "";

  if (lance === 'pares') {
    const a1 = ganador === 0 ? 0 : 1;
    const a2 = ganador === 0 ? 2 : 3;
    const p1 = evaluarDetallePares(sala.manos[a1]);
    const p2 = evaluarDetallePares(sala.manos[a2]);
    const nom1 = Object.values(sala.jugadoresPorToken).find(p => p.asiento === a1)?.nombre || `Asiento ${a1+1}`;
    const nom2 = Object.values(sala.jugadoresPorToken).find(p => p.asiento === a2)?.nombre || `Asiento ${a2+1}`;

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
      const nom1 = Object.values(sala.jugadoresPorToken).find(p => p.asiento === a1)?.nombre || `Asiento ${a1+1}`;
      const nom2 = Object.values(sala.jugadoresPorToken).find(p => p.asiento === a2)?.nombre || `Asiento ${a2+1}`;

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

    let empate = (max0 === max1);
    let pareja = max0 > max1 ? 0 : (max1 > max0 ? 1 : (tieneMano(a0, a1) ? 0 : 1));
    let asiento = pareja === 0 ? a0 : a1;
    const nom = Object.values(sala.jugadoresPorToken).find(p => p.asiento === asiento)?.nombre || `Asiento ${asiento+1}`;
    let motivo = empate ? `Grande ganada por ${nom} por ser Mano (empate a carta más alta)` : `Grande ganada por ${nom} con la carta más alta`;
    return { parejaGanadora: pareja, asientoGanador: asiento, nombreGanador: nom, motivo };
  }

  if (lance === 'chica') {
    let m = [menorCarta(sala.manos[0]), menorCarta(sala.manos[1]), menorCarta(sala.manos[2]), menorCarta(sala.manos[3])];
    let min0 = Math.min(m[0], m[2]), min1 = Math.min(m[1], m[3]);
    let a0 = m[0] <= m[2] ? 0 : 2;
    let a1 = m[1] <= m[3] ? 1 : 3;

    let empate = (min0 === min1);
    let pareja = min0 < min1 ? 0 : (min1 < min0 ? 1 : (tieneMano(a0, a1) ? 0 : 1));
    let asiento = pareja === 0 ? a0 : a1;
    const nom = Object.values(sala.jugadoresPorToken).find(p => p.asiento === asiento)?.nombre || `Asiento ${asiento+1}`;
    let motivo = empate ? `Chica ganada por ${nom} por ser Mano (empate a carta más baja)` : `Chica ganada por ${nom} con la carta más baja`;
    return { parejaGanadora: pareja, asientoGanador: asiento, nombreGanador: nom, motivo };
  }

  if (lance === 'pares') {
    let p = [evaluarDetallePares(sala.manos[0]), evaluarDetallePares(sala.manos[1]), evaluarDetallePares(sala.manos[2]), evaluarDetallePares(sala.manos[3])];
    let f0 = Math.max(p[0].fuerza, p[2].fuerza), f1 = Math.max(p[1].fuerza, p[3].fuerza);
    let a0 = p[0].fuerza >= p[2].fuerza ? 0 : 2;
    let a1 = p[1].fuerza >= p[3].fuerza ? 1 : 3;

    let empate = (f0 === f1);
    let pareja = f0 > f1 ? 0 : (f1 > f0 ? 1 : (tieneMano(a0, a1) ? 0 : 1));
    let asiento = pareja === 0 ? a0 : a1;
    let det = p[asiento];
    const nom = Object.values(sala.jugadoresPorToken).find(p => p.asiento === asiento)?.nombre || `Asiento ${asiento+1}`;
    let motivo = empate ? `Pares ganados por ${nom} por ser Mano con ${det.nombre} (empate exacto)` : `Pares ganados por ${nom} con ${det.nombre}`;
    return { parejaGanadora: pareja, asientoGanador: asiento, nombreGanador: nom, motivo };
  }

  if (lance === 'juego') {
    let j = [evaluarDetalleJuego(sala.manos[0]), evaluarDetalleJuego(sala.manos[1]), evaluarDetalleJuego(sala.manos[2]), evaluarDetalleJuego(sala.manos[3])];
    let f0 = Math.max(j[0].fuerza, j[2].fuerza), f1 = Math.max(j[1].fuerza, j[3].fuerza);
    let a0 = j[0].fuerza >= j[2].fuerza ? 0 : 2;
    let a1 = j[1].fuerza >= j[3].fuerza ? 1 : 3;

    let empate = (f0 === f1);
    let pareja = f0 > f1 ? 0 : (f1 > f0 ? 1 : (tieneMano(a0, a1) ? 0 : 1));
    let asiento = pareja === 0 ? a0 : a1;
    let det = j[asiento];
    const nom = Object.values(sala.jugadoresPorToken).find(p => p.asiento === asiento)?.nombre || `Asiento ${asiento+1}`;
    let motivo = empate ? `Juego ganado por ${nom} por ser Mano con ${det.desc} (empate exacto)` : `Juego ganado por ${nom} con ${det.desc}`;
    return { parejaGanadora: pareja, asientoGanador: asiento, nombreGanador: nom, motivo };
  }
}

function comprobarVictoriaChico(sala, ganadorForzado = null, motivo = "", esOrdago = false) {
  let ganador = ganadorForzado;
  if (ganador === null) {
    if (sala.puntos[0] >= 40) ganador = 0;
    else if (sala.puntos[1] >= 40) ganador = 1;
  }

  if (ganador !== null) {
    sala.chicosGanados[ganador] += 1;
    let msgFinal = esOrdago ? motivo : `¡Pareja ${ganador + 1} alcanza 40 puntos y gana el Chico! Chicos: ${sala.chicosGanados[0]} - ${sala.chicosGanados[1]}`;

    let vacaGanada = false;
    if (sala.chicosGanados[ganador] >= 3) {
      sala.vacasGanadas[ganador] += 1;
      sala.chicosGanados = { 0: 0, 1: 0 };
      vacaGanada = true;
      msgFinal = `🏆 ¡¡VICTORIA TOTAL!! Pareja ${ganador + 1} gana 3 Chicos y se lleva LA VACA del torneo.`;
    }

    sala.puntos = { 0: 0, 1: 0 };
    sala.asientoMano = (sala.asientoMano + 1) % 4;

    io.to(sala.id).emit('victoriaChico', {
      ganadorPareja: ganador,
      mensaje: msgFinal,
      chicosGanados: sala.chicosGanados,
      vacasGanadas: sala.vacasGanadas,
      esVaca: vacaGanada
    });

    notificarEstado(sala, msgFinal);
    setTimeout(() => iniciarMano(sala), 4000);
    return true;
  }
  return false;
}

function ejecutarResetAdmin(sala) {
  limpiarTimersBots(sala);
  limpiarTimerDecision(sala);
  sala.jugadoresPorToken = {};
  sala.enPartida = false;
  sala.mazo = [];
  sala.descartes = [];
  sala.manos = { 0: [], 1: [], 2: [], 3: [] };
  sala.puntos = { 0: 0, 1: 0 };
  sala.chicosGanados = { 0: 0, 1: 0 };
  sala.vacasGanadas = { 0: 0, 1: 0 };
  sala.fase = 'espera';
  sala.asientoMano = 0;
  sala.turno = 0;
  sala.ordenMusVotos = {};
  sala.declaraciones = { pares: {}, juego: {} };
  sala.apuestaActual = { total: 0, ultimoAumento: 0, ultimoApostador: null, ordago: false, enPaso: true };
  sala.decisionPareja = { activa: false, parejaVotante: null, votos: {}, tiempoRestante: 10, timerId: null };

  emitirActualizacionAsientos(sala);
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
      socket.emit('asientoAsignado', { asiento: j.asiento, info: j, salaId: miSalaId });
      if (sala.enPartida) {
        socket.emit('misCartas', sala.manos[j.asiento] || []);
      }
      emitirActualizacionAsientos(sala);
      notificarEstado(sala, `${j.nombre} se ha reconectado a la partida.`);
      return;
    }

    socket.emit('asientosEstado', obtenerEstadoAsientos(sala));
  });

  socket.on('unirseAsiento', ({ nombre, asientoElegido, salaId, token }) => {
    const sId = (salaId && salaId.trim() !== "") ? salaId.trim().toLowerCase() : miSalaId;
    const sala = obtenerOCrearSala(sId);
    miToken = token;

    const ocupado = Object.values(sala.jugadoresPorToken).some(j => j.asiento === asientoElegido);
    if (ocupado) {
      socket.emit('errorAsiento', "Ese asiento ya está ocupado. Elige otro.");
      return;
    }

    const aInfo = ASIENTOS_INFO[asientoElegido];
    const nombreFinal = (nombre && nombre.trim() !== '') ? nombre.trim() : `Jugador ${asientoElegido + 1}`;

    sala.jugadoresPorToken[miToken] = {
      asiento: asientoElegido,
      nombre: nombreFinal,
      pareja: aInfo.pareja,
      esBot: false,
      socketId: socket.id
    };

    socket.emit('asientoAsignado', { asiento: asientoElegido, info: sala.jugadoresPorToken[miToken], salaId: sId });
    emitirActualizacionAsientos(sala);
    notificarEstado(sala, `${nombreFinal} se sentó en ${aInfo.nombreDef}.`);

    if (Object.keys(sala.jugadoresPorToken).length === 4 && !sala.enPartida) {
      iniciarMano(sala);
    }
  });

  socket.on('rellenarBots', () => {
    const sala = obtenerOCrearSala(miSalaId);
    let ocupados = Object.values(sala.jugadoresPorToken).map(j => j.asiento);

    if (!miToken || !sala.jugadoresPorToken[miToken]) {
      let primerLibre = [0, 1, 2, 3].find(a => !ocupados.includes(a));
      if (primerLibre !== undefined) {
        const aInfo = ASIENTOS_INFO[primerLibre];
        miToken = miToken || `user_${Date.now()}`;
        sala.jugadoresPorToken[miToken] = {
          asiento: primerLibre,
          nombre: "Mario",
          pareja: aInfo.pareja,
          esBot: false,
          socketId: socket.id
        };
        socket.emit('asientoAsignado', { asiento: primerLibre, info: sala.jugadoresPorToken[miToken], salaId: miSalaId });
      }
    }

    ocupados = Object.values(sala.jugadoresPorToken).map(j => j.asiento);
    [0, 1, 2, 3].forEach(a => {
      if (!ocupados.includes(a)) {
        const aInfo = ASIENTOS_INFO[a];
        sala.jugadoresPorToken[`bot_${a}`] = {
          asiento: a,
          nombre: `🤖 Bot ${a + 1}`,
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
    if (sala.turno !== j.asiento) return;

    if (sala.fase === 'declaracion_pares') {
      procesarDeclaracionPares(sala, j.asiento, lleva);
    } else if (sala.fase === 'declaracion_juego') {
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

  socket.on('votoMus', ({ quiereMus }) => {
    const sala = obtenerOCrearSala(miSalaId);
    if (!miToken || !sala.jugadoresPorToken[miToken]) return;
    const j = sala.jugadoresPorToken[miToken];
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
    if (sala.fase !== 'descartes') return;

    let mano = sala.manos[j.asiento];
    indices.sort((a,b) => b - a).forEach(idx => {
      const c = mano.splice(idx, 1)[0];
      if (c) sala.descartes.push(c);
      mano.push(robarCarta(sala));
    });
    sala.ordenMusVotos[j.asiento] = 'listo';
    comprobarFinDescartes(sala);
  });

  socket.on('accionLance', (accion) => {
    const sala = obtenerOCrearSala(miSalaId);
    if (!miToken || !sala.jugadoresPorToken[miToken]) return;
    const j = sala.jugadoresPorToken[miToken];
    if (!jugadorPuedeHablarEnLance(sala, j.asiento, sala.fase)) {
      socket.emit('avisoNoPuedeHablar', { motivo: sala.fase === 'pares' ? "No tienes pares" : "No tienes juego" });
      return;
    }

    if (sala.decisionPareja.activa && ASIENTOS_INFO[j.asiento].pareja === sala.decisionPareja.parejaVotante) {
      registrarVotoPareja(sala, j.asiento, accion);
    } else {
      ejecutarAccionLance(sala, j, accion);
    }
  });

  socket.on('disconnect', () => {
    const sala = salas[miSalaId];
    if (sala && miToken && sala.jugadoresPorToken[miToken]) {
      sala.jugadoresPorToken[miToken].socketId = null;
      notificarEstado(sala, `${sala.jugadoresPorToken[miToken].nombre} se ha desconectado momentáneamente.`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`El Mus de Mario ejecutándose en el puerto ${PORT}`));
