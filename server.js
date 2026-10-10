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
  { id: 0, rol: "Mano", pareja: 0 },
  { id: 1, rol: "Segundo", pareja: 1 },
  { id: 2, rol: "Tercero", pareja: 0 },
  { id: 3, rol: "Postre", pareja: 1 }
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
  esperandoRespuestaDe: null,
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

function jugadorPuedeHablarEnLance(asiento, lance) {
  const mano = sala.manos[asiento];
  if (!mano || mano.length === 0) return false;
  if (lance === 'pares') return evaluarPares(mano) > 0;
  if (lance === 'juego') {
    if (sala.apuestasLances.juego.esAlPunto) return true;
    return evaluarJuego(mano) >= 31;
  }
  return true;
}

function notificarEstado(msg) {
  let permisosHabla = {};
  for (let a = 0; a < 4; a++) {
    permisosHabla[a] = jugadorPuedeHablarEnLance(a, sala.fase);
  }

  // Revelar todas las cartas únicamente durante el recuento final o fin de partida
  const revelarTodas = (sala.fase === 'recuento' || sala.fase === 'fin');

  io.emit('estadoJuego', {
    fase: sala.fase,
    turno: sala.turno,
    puntos: sala.puntos,
    apuestaActual: sala.apuestaActual,
    apuestasLances: sala.apuestasLances,
    esperandoRespuestaDe: sala.esperandoRespuestaDe,
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

  if (nombreLance === 'pares') {
    const p0 = evaluarPares(sala.manos[0]) > 0 || evaluarPares(sala.manos[2]) > 0;
    const p1 = evaluarPares(sala.manos[1]) > 0 || evaluarPares(sala.manos[3]) > 0;

    if (!p0 && !p1) {
      sala.apuestasLances.pares.hayPares = false;
      notificarEstado("Nadie tiene pares. Lance desierto.");
      setTimeout(() => avanzarSiguienteLance(), 1800);
      return;
    }
    if (p0 && !p1) {
      sala.apuestasLances.pares.hayPares = true;
      notificarEstado("Solo Pareja 1 lleva pares. No hay envite.");
      setTimeout(() => avanzarSiguienteLance(), 1800);
      return;
    }
    if (!p0 && p1) {
      sala.apuestasLances.pares.hayPares = true;
      notificarEstado("Solo Pareja 2 lleva pares. No hay envite.");
      setTimeout(() => avanzarSiguienteLance(), 1800);
      return;
    }
    sala.apuestasLances.pares.hayPares = true;
  }

  if (nombreLance === 'juego') {
    const j0 = evaluarJuego(sala.manos[0]) >= 31 || evaluarJuego(sala.manos[2]) >= 31;
    const j1 = evaluarJuego(sala.manos[1]) >= 31 || evaluarJuego(sala.manos[3]) >= 31;

    if (!j0 && !j1) {
      sala.apuestasLances.juego.esAlPunto = true;
      notificarEstado("Nadie tiene juego (31 o más). Se disputa AL PUNTO.");
    } else if (j0 && !j1) {
      sala.apuestasLances.juego.esAlPunto = false;
      notificarEstado("Solo Pareja 1 lleva juego. No hay envite.");
      setTimeout(() => avanzarSiguienteLance(), 1800);
      return;
    } else if (!j0 && j1) {
      sala.apuestasLances.juego.esAlPunto = false;
      notificarEstado("Solo Pareja 2 lleva juego. No hay envite.");
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
    io.emit('mensajeChat', { jugador: jSaltado?.nombre || 'Jugador', texto: sala.fase === 'pares' ? "No tengo pares" : "No tengo juego" });
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
        const botRespondiendo = Object.values(sala.jugadores).find(j =>
          j.esBot &&
          ASIENTOS_INFO[j.asiento].pareja === sala.esperandoRespuestaDe &&
          jugadorPuedeHablarEnLance(j.asiento, sala.fase)
        );
        if (botRespondiendo) {
          const accion = Math.random() > 0.4 ? { tipo: 'quiero' } : { tipo: 'noquiero' };
          ejecutarAccionLance(botRespondiendo, accion);
        }
      } else {
        const jActual = Object.values(sala.jugadores).find(j => j.asiento === sala.turno);
        if (jActual && jActual.esBot) {
          if (!jugadorPuedeHablarEnLance(jActual.asiento, sala.fase)) {
            ejecutarAccionLance(jActual, { tipo: 'paso' });
          } else {
            const accion = Math.random() > 0.65 ? { tipo: 'envidar', cantidad: 2 } : { tipo: 'paso' };
            ejecutarAccionLance(jActual, accion);
          }
        }
      }
    }
  }, 1100);
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
    sala.esperandoRespuestaDe = parejaRival;

    io.emit('mensajeChat', { jugador: jugador.nombre, texto: `¡Envido ${aumento}! (Bote: ${sala.apuestaActual.total})` });
    notificarEstado(`Envite de ${aumento}. Responde Pareja ${parejaRival + 1}`);
    comprobarTurnoBot();
  } else if (tipo === 'ordago') {
    sala.apuestaActual.ordago = true;
    sala.apuestaActual.ultimoApostador = pareja;
    sala.apuestaActual.enPaso = false;
    sala.esperandoRespuestaDe = parejaRival;

    io.emit('mensajeChat', { jugador: jugador.nombre, texto: "¡ÓRDAGO!" });
    notificarEstado(`¡ÓRDAGO de ${jugador.nombre}!`);
    comprobarTurnoBot();
  } else if (tipo === 'quiero') {
    io.emit('mensajeChat', { jugador: jugador.nombre, texto: "¡QUIERO!" });
    sala.apuestasLances[sala.fase].querido = true;
    sala.apuestasLances[sala.fase].puntos = sala.apuestaActual.ordago ? 40 : sala.apuestaActual.total;
    sala.apuestasLances[sala.fase].ordago = sala.apuestaActual.ordago;

    notificarEstado(`¡Envite aceptado de ${sala.apuestasLances[sala.fase].puntos} puntos! Se cobrará al recuento.`);
    setTimeout(() => avanzarSiguienteLance(), 1600);
  } else if (tipo === 'noquiero') {
    io.emit('mensajeChat', { jugador: jugador.nombre, texto: "No quiero (Para ti)" });
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

function ejecutarRecuentoFinalMano() {
  sala.fase = 'recuento';
  // Al pasar a recuento, notificarEstado() envía todas las manos para activar la animación de revelado
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
    let s0 = Math.max(sala.manos[0].reduce((a,c)=>a+c.valorJuego,0), sala.manos[2].reduce((a,c)=>a+c.valorJuego,0));
    let s1 = Math.max(sala.manos[1].reduce((a,c)=>a+c.valorJuego,0), sala.manos[3].reduce((a,c)=>a+c.valorJuego,0));
    return s0 >= s1 ? 0 : 1;
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
      notificarEstado(`${nombreFinal} se ha unido.`);
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
    notificarEstado("Mesa completada con Bots.");
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
    ejecutarAccionLance(j, accion);
  });

  socket.on('disconnect', () => {
    if (sala.jugadores[socket.id]) {
      const nom = sala.jugadores[socket.id].nombre;
      delete sala.jugadores[socket.id];
      sala.enPartida = false;
      sala.fase = 'espera';
      notificarEstado(`${nom} ha salido. Partida en pausa.`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`El Mus de Mario en http://localhost:${PORT}`));
