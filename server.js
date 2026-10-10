const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Sirve desde /public o desde la raíz para evitar errores de despliegue
const publicDir = fs.existsSync(path.join(__dirname, 'public')) ? path.join(__dirname, 'public') : __dirname;
app.use(express.static(publicDir));

const ASIENTOS_INFO = [
  { id: 0, rol: "Mano", pareja: 0 },
  { id: 1, rol: "Segundo", pareja: 1 },
  { id: 2, rol: "Tercero", pareja: 0 },
  { id: 3, rol: "Postre", pareja: 1 }
];

let sala = {
  jugadores: {}, // socketId -> { asiento, nombre, esBot }
  enPartida: false,
  mazo: [],
  descartes: [],
  manos: { 0: [], 1: [], 2: [], 3: [] },
  puntos: { 0: 0, 1: 0 },
  fase: 'espera', // 'espera', 'mus', 'descartes', 'grande', 'chica', 'pares', 'juego', 'recuento', 'fin'
  turno: 0,
  ordenMusVotos: {},
  // Estado de apuestas del lance actual
  apuestaActual: {
    total: 0,
    ultimoAumento: 0,
    ultimoApostador: null, // 0 o 1 (pareja)
    ordago: false,
    enPaso: true
  },
  esperandoRespuestaDe: null, // pareja (0 o 1)
  // Bote de puntos diferidos para el recuento final
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

function iniciarMano() {
  sala.mazo = crearMazo();
  sala.descartes = [];
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
  notificarEstado("Mano repartida. Empieza la ronda de Mus.");
  comprobarTurnoBot();
}

function notificarEstado(msg) {
  io.emit('estadoJuego', {
    fase: sala.fase,
    turno: sala.turno,
    puntos: sala.puntos,
    apuestaActual: sala.apuestaActual,
    apuestasLances: sala.apuestasLances,
    esperandoRespuestaDe: sala.esperandoRespuestaDe,
    mensaje: msg,
    jugadoresEnMesa: sala.jugadores,
    enPartida: sala.enPartida
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
  sala.esperandoRespuestaDe = null;

  // Verificaciones de Pares y Juego
  if (nombreLance === 'pares') {
    let p0 = Math.max(evaluarPares(sala.manos[0]), evaluarPares(sala.manos[2]));
    let p1 = Math.max(evaluarPares(sala.manos[1]), evaluarPares(sala.manos[3]));
    if (p0 === 0 && p1 === 0) {
      sala.apuestasLances.pares.hayPares = false;
      notificarEstado("Nadie tiene pares. Se pasa al siguiente lance.");
      setTimeout(() => avanzarSiguienteLance(), 1500);
      return;
    }
    sala.apuestasLances.pares.hayPares = true;
  } else if (nombreLance === 'juego') {
    let j0 = Math.max(evaluarJuego(sala.manos[0]), evaluarJuego(sala.manos[2]));
    let j1 = Math.max(evaluarJuego(sala.manos[1]), evaluarJuego(sala.manos[3]));
    sala.apuestasLances.juego.esAlPunto = (j0 === 0 && j1 === 0);
  }

  notificarEstado(`Ronda de ${nombreLance.toUpperCase()}. Habla el mano.`);
  comprobarTurnoBot();
}

function comprobarTurnoBot() {
  setTimeout(() => {
    if (sala.fase === 'mus') {
      const jActual = Object.values(sala.jugadores).find(j => j.asiento === sala.turno);
      if (jActual && jActual.esBot) {
        const m = sala.manos[jActual.asiento];
        const reyes = m.filter(c => c.valorMus === 12).length;
        const quiereMus = reyes < 3;
        if (quiereMus) {
          sala.ordenMusVotos[jActual.asiento] = true;
          io.emit('mensajeChat', { jugador: jActual.nombre, texto: "¡Mus!" });
          siguienteTurnoMus();
        } else {
          io.emit('mensajeChat', { jugador: jActual.nombre, texto: "¡Corto! No hay mus" });
          iniciarLance('grande');
        }
      }
    } else if (['grande', 'chica', 'pares', 'juego'].includes(sala.fase)) {
      if (sala.esperandoRespuestaDe !== null) {
        const botRespondiendo = Object.values(sala.jugadores).find(j => j.esBot && ASIENTOS_INFO[j.asiento].pareja === sala.esperandoRespuestaDe);
        if (botRespondiendo) {
          const accion = Math.random() > 0.4 ? { tipo: 'quiero' } : { tipo: 'noquiero' };
          ejecutarAccionLance(botRespondiendo, accion);
        }
      } else {
        const jActual = Object.values(sala.jugadores).find(j => j.asiento === sala.turno);
        if (jActual && jActual.esBot) {
          const accion = Math.random() > 0.65 ? { tipo: 'envidar', cantidad: 2 } : { tipo: 'paso' };
          ejecutarAccionLance(jActual, accion);
        }
      }
    }
  }, 1200);
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
    notificarEstado("Todos descartados. Se vuelve a preguntar si hay Mus.");
    comprobarTurnoBot();
  }
}

function ejecutarAccionLance(jugador, { tipo, cantidad }) {
  const pareja = ASIENTOS_INFO[jugador.asiento].pareja;
  const parejaRival = pareja === 0 ? 1 : 0;

  if (tipo === 'paso') {
    io.emit('mensajeChat', { jugador: jugador.nombre, texto: "Paso" });
    sala.turno = (sala.turno + 1) % 4;
    if (sala.turno === 0) {
      // Los cuatro han pasado sin envidar
      sala.apuestasLances[sala.fase].enPaso = true;
      sala.apuestasLances[sala.fase].puntos = 1;
      notificarEstado(`Ronda de ${sala.fase.toUpperCase()} queda en paso.`);
      setTimeout(() => avanzarSiguienteLance(), 1500);
    } else {
      const sig = Object.values(sala.jugadores).find(j => j.asiento === sala.turno);
      notificarEstado(`Turno de ${sig?.nombre || 'Jugador'}`);
      comprobarTurnoBot();
    }
  } else if (tipo === 'envidar') {
    const aumento = parseInt(cantidad) || 2;
    sala.apuestaActual.total += aumento;
    sala.apuestaActual.ultimoAumento = aumento;
    sala.apuestaActual.ultimoApostador = pareja;
    sala.apuestaActual.enPaso = false;
    sala.esperandoRespuestaDe = parejaRival;

    io.emit('mensajeChat', { jugador: jugador.nombre, texto: `¡Envido ${aumento}! (Bote acumulado: ${sala.apuestaActual.total})` });
    notificarEstado(`Envite de ${aumento}. Responde la Pareja ${parejaRival + 1}`);
    comprobarTurnoBot();
  } else if (tipo === 'ordago') {
    sala.apuestaActual.ordago = true;
    sala.apuestaActual.ultimoApostador = pareja;
    sala.apuestaActual.enPaso = false;
    sala.esperandoRespuestaDe = parejaRival;

    io.emit('mensajeChat', { jugador: jugador.nombre, texto: "¡ÓRDAGO!" });
    notificarEstado(`¡ÓRDAGO lanzado por ${jugador.nombre}!`);
    comprobarTurnoBot();
  } else if (tipo === 'quiero') {
    io.emit('mensajeChat', { jugador: jugador.nombre, texto: "¡QUIERO!" });
    sala.apuestasLances[sala.fase].querido = true;
    sala.apuestasLances[sala.fase].puntos = sala.apuestaActual.ordago ? 40 : sala.apuestaActual.total;
    sala.apuestasLances[sala.fase].ordago = sala.apuestaActual.ordago;

    notificarEstado(`¡Envite aceptado de ${sala.apuestasLances[sala.fase].puntos} puntos! Se resolverá al final.`);
    setTimeout(() => avanzarSiguienteLance(), 1600);
  } else if (tipo === 'noquiero') {
    io.emit('mensajeChat', { jugador: jugador.nombre, texto: "No quiero (Para ti)" });
    // REGLA OFICIAL: Si es el primer envite y dicen no quiero -> 1 punto al apostador.
    // Si ya hubo subidas (ej: 2 a 4) -> se lleva la apuesta anterior sin el último aumento.
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

function avanzarSiguienteLance() {
  const lances = ['grande', 'chica', 'pares', 'juego'];
  let idx = lances.indexOf(sala.fase);
  if (idx !== -1 && idx < lances.length - 1) {
    iniciarLance(lances[idx + 1]);
  } else {
    ejecutarRecuentoFinalMano();
  }
}

// TANTEO FINAL ORDENADO LANCE POR LANCE
function ejecutarRecuentoFinalMano() {
  sala.fase = 'recuento';
  notificarEstado("¡A enseñar cartas! Resolviendo el tanteo reglamentario...");

  setTimeout(() => {
    // 1. Grande
    resolverLanceEnRecuento('grande');
    if (comprobarFinPartida()) return;

    setTimeout(() => {
      // 2. Chica
      resolverLanceEnRecuento('chica');
      if (comprobarFinPartida()) return;

      setTimeout(() => {
        // 3. Pares
        if (sala.apuestasLances.pares.hayPares) {
          resolverLanceEnRecuento('pares');
          if (comprobarFinPartida()) return;
        }

        setTimeout(() => {
          // 4. Juego / Punto
          resolverLanceEnRecuento('juego');
          if (comprobarFinPartida()) return;

          setTimeout(() => {
            notificarEstado("Fin de la mano. Repartiendo siguiente...");
            setTimeout(iniciarMano, 2000);
          }, 2000);
        }, 1500);
      }, 1500);
    }, 1500);
  }, 1500);
}

function resolverLanceEnRecuento(lance) {
  const info = sala.apuestasLances[lance];
  if (info.resueltoEnFalso) return; // Ya se cobró durante el envite

  let ganador = evaluarGanadorLance(lance);
  let pts = info.puntos;

  // Si fue en paso en pares o juego, se cobran los tantos propios
  if (info.enPaso && lance === 'pares') {
    let pPar = Math.max(evaluarPares(sala.manos[0]), evaluarPares(sala.manos[2]), evaluarPares(sala.manos[1]), evaluarPares(sala.manos[3]));
    pts = pPar >= 3 ? 3 : (pPar === 2 ? 2 : 1);
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
    p0 = Math.max(evaluarPares(sala.manos[0]), evaluarPares(sala.manos[2]));
    p1 = Math.max(evaluarPares(sala.manos[1]), evaluarPares(sala.manos[3]));
    return p0 >= p1 ? 0 : 1;
  } else if (lance === 'juego') {
    let j0 = Math.max(evaluarJuego(sala.manos[0]), evaluarJuego(sala.manos[2]));
    let j1 = Math.max(evaluarJuego(sala.manos[1]), evaluarJuego(sala.manos[3]));
    if (j0 > 0 || j1 > 0) {
      if (j0 === 31) return 0;
      if (j1 === 31) return 1;
      return j0 >= j1 ? 0 : 1;
    }
    // Al punto
    let sumaP0 = Math.max(sumaPunto(sala.manos[0]), sumaPunto(sala.manos[2]));
    let sumaP1 = Math.max(sumaPunto(sala.manos[1]), sumaPunto(sala.manos[3]));
    return sumaP0 >= sumaP1 ? 0 : 1;
  }
  return p0 >= p1 ? 0 : 1;
}

function evaluarPares(m) {
  let cnt = {};
  m.forEach(c => cnt[c.valorMus] = (cnt[c.valorMus] || 0) + 1);
  let vals = Object.values(cnt);
  if (vals.includes(4)) return 4;
  if (vals.filter(v => v === 2).length === 2) return 3;
  if (vals.includes(3)) return 2;
  if (vals.includes(2)) return 1;
  return 0;
}

function evaluarJuego(m) {
  let s = m.reduce((acc, c) => acc + c.valorJuego, 0);
  return s >= 31 ? s : 0;
}

function sumaPunto(m) {
  return m.reduce((acc, c) => acc + c.valorJuego, 0);
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
  socket.on('unirse', ({ nombre }) => {
    const ocupados = Object.values(sala.jugadores).map(j => j.asiento);
    let asientoLibre = [0, 1, 2, 3].find(a => !ocupados.includes(a));

    if (asientoLibre !== undefined) {
      const nombreFinal = (nombre && nombre.trim() !== '') ? nombre.trim() : `Jugador ${asientoLibre + 1}`;
      sala.jugadores[socket.id] = {
        asiento: asientoLibre,
        nombre: nombreFinal,
        rol: ASIENTOS_INFO[asientoLibre].rol,
        pareja: ASIENTOS_INFO[asientoLibre].pareja,
        esBot: false
      };
      socket.emit('asientoAsignado', { asiento: asientoLibre, info: sala.jugadores[socket.id] });
      notificarEstado(`${nombreFinal} se ha unido a la mesa.`);
    } else {
      socket.emit('mesaLlena');
    }

    if (Object.keys(sala.jugadores).length === 4 && !sala.enPartida) {
      iniciarMano();
    }
  });

  socket.on('rellenarBots', () => {
    const ocupados = Object.values(sala.jugadores).map(j => j.asiento);
    [0, 1, 2, 3].forEach(a => {
      if (!ocupados.includes(a)) {
        const idBot = `bot_${a}`;
        sala.jugadores[idBot] = {
          asiento: a,
          nombre: `🤖 Bot ${a + 1}`,
          rol: ASIENTOS_INFO[a].rol,
          pareja: ASIENTOS_INFO[a].pareja,
          esBot: true
        };
      }
    });
    notificarEstado("Huecos de la mesa rellenados con Bots.");
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
    if (j) ejecutarAccionLance(j, accion);
  });

  socket.on('disconnect', () => {
    if (sala.jugadores[socket.id]) {
      const nombreSaliendo = sala.jugadores[socket.id].nombre;
      delete sala.jugadores[socket.id];
      sala.enPartida = false;
      sala.fase = 'espera';
      notificarEstado(`${nombreSaliendo} se desconectó. Mesa pausada.`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`El Mus de Mario corriendo en http://localhost:${PORT}`));
