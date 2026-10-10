const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const ASIENTOS = [
  { id: 0, nombre: "Jugador 1 (Mano)", pareja: 0 },
  { id: 1, nombre: "Jugador 2", pareja: 1 },
  { id: 2, nombre: "Jugador 3", pareja: 0 },
  { id: 3, nombre: "Jugador 4 (Postre)", pareja: 1 }
];

let sala = {
  jugadores: {}, // socketId -> { asiento, nombre, esBot }
  enPartida: false,
  mazo: [],
  descartes: [],
  manos: { 0: [], 1: [], 2: [], 3: [] },
  puntos: { 0: 0, 1: 0 },
  fase: 'espera',
  turno: 0,
  ordenMusVotos: {},
  apuesta: { valor: 0, ultimoApostador: null, ultimoAumento: 2, ordago: false },
  esperandoRespuestaDe: null
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
  notificarEstado("Nueva mano repartida. Ronda de Mus iniciada.");
  comprobarTurnoBot();
}

function notificarEstado(msg) {
  io.emit('estadoJuego', {
    fase: sala.fase,
    turno: sala.turno,
    puntos: sala.puntos,
    apuesta: sala.apuesta,
    esperandoRespuestaDe: sala.esperandoRespuestaDe,
    mensaje: msg,
    jugadoresEnMesa: sala.jugadores
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
    notificarEstado(`Turno de ${ASIENTOS[sala.turno].nombre}: ¿Mus o Cortar?`);
    comprobarTurnoBot();
  }
}

function iniciarRonda(nombreRonda) {
  sala.fase = nombreRonda;
  sala.turno = 0;
  sala.apuesta = { valor: 0, ultimoApostador: null, ultimoAumento: 2, ordago: false };
  sala.esperandoRespuestaDe = null;
  notificarEstado(`Comienza ${nombreRonda.toUpperCase()}. Habla el mano.`);
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
          io.emit('mensajeChat', { jugador: jActual.nombre, texto: "¡No hay Mus!" });
          iniciarRonda('grande');
        }
      }
    } else if (['grande', 'chica', 'pares', 'juego'].includes(sala.fase)) {
      if (sala.esperandoRespuestaDe !== null) {
        const botRespondiendo = Object.values(sala.jugadores).find(j => j.esBot && ASIENTOS[j.asiento].pareja === sala.esperandoRespuestaDe);
        if (botRespondiendo) {
          ejecutarAccionLance(botRespondiendo, { tipo: Math.random() > 0.5 ? 'quiero' : 'noquiero' });
        }
      } else {
        const jActual = Object.values(sala.jugadores).find(j => j.asiento === sala.turno);
        if (jActual && jActual.esBot) {
          const accion = Math.random() > 0.6 ? { tipo: 'envidar', cantidad: 2 } : { tipo: 'paso' };
          ejecutarAccionLance(jActual, accion);
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

function ejecutarAccionLance(jugador, { tipo, cantidad }) {
  const pareja = ASIENTOS[jugador.asiento].pareja;
  const parejaRival = pareja === 0 ? 1 : 0;

  if (tipo === 'paso') {
    io.emit('mensajeChat', { jugador: jugador.nombre, texto: "Paso" });
    sala.turno = (sala.turno + 1) % 4;
    if (sala.turno === 0) {
      resolverPasoLance();
    } else {
      notificarEstado(`Turno de ${ASIENTOS[sala.turno].nombre}`);
      comprobarTurnoBot();
    }
  } else if (tipo === 'envidar') {
    const aumento = parseInt(cantidad) || 2;
    sala.apuesta.valor += aumento;
    sala.apuesta.ultimoAumento = aumento;
    sala.apuesta.ultimoApostador = pareja;
    sala.esperandoRespuestaDe = parejaRival;
    io.emit('mensajeChat', { jugador: jugador.nombre, texto: `¡Envido ${aumento}! (Bote: ${sala.apuesta.valor})` });
    notificarEstado(`Envite de ${aumento}. Responde Pareja ${parejaRival + 1}`);
    comprobarTurnoBot();
  } else if (tipo === 'ordago') {
    sala.apuesta.ordago = true;
    sala.apuesta.ultimoApostador = pareja;
    sala.esperandoRespuestaDe = parejaRival;
    io.emit('mensajeChat', { jugador: jugador.nombre, texto: "¡ÓRDAGO!" });
    notificarEstado(`¡ÓRDAGO de ${jugador.nombre}!`);
    comprobarTurnoBot();
  } else if (tipo === 'quiero') {
    io.emit('mensajeChat', { jugador: jugador.nombre, texto: "¡QUIERO!" });
    resolverLanceDisputado(true);
  } else if (tipo === 'noquiero') {
    io.emit('mensajeChat', { jugador: jugador.nombre, texto: "No quiero" });
    const pts = sala.apuesta.valor > sala.apuesta.ultimoAumento ? (sala.apuesta.valor - sala.apuesta.ultimoAumento) : 1;
    sala.puntos[sala.apuesta.ultimoApostador] += pts;
    avanzarSiguienteRonda();
  }
}

function resolverPasoLance() {
  resolverLanceDisputado(false);
}

function resolverLanceDisputado(conApuesta) {
  let pts = conApuesta ? (sala.apuesta.ordago ? 40 : sala.apuesta.valor) : 1;
  let ganadorPareja = evaluarGanador(sala.fase);
  sala.puntos[ganadorPareja] += pts;
  notificarEstado(`Pareja ${ganadorPareja + 1} se lleva ${pts} punto(s) en ${sala.fase.toUpperCase()}`);
  avanzarSiguienteRonda();
}

function evaluarGanador(fase) {
  const mayorCarta = (m) => Math.max(...m.map(c => c.valorMus));
  const menorCarta = (m) => Math.min(...m.map(c => c.valorMus));
  let p0 = Math.max(mayorCarta(sala.manos[0]), mayorCarta(sala.manos[2]));
  let p1 = Math.max(mayorCarta(sala.manos[1]), mayorCarta(sala.manos[3]));
  if (fase === 'chica') {
    p0 = Math.min(menorCarta(sala.manos[0]), menorCarta(sala.manos[2]));
    p1 = Math.min(menorCarta(sala.manos[1]), menorCarta(sala.manos[3]));
    return p0 <= p1 ? 0 : 1;
  }
  return p0 >= p1 ? 0 : 1;
}

function avanzarSiguienteRonda() {
  if (sala.puntos[0] >= 40 || sala.puntos[1] >= 40) {
    sala.fase = 'fin';
    notificarEstado(`¡FIN DE PARTIDA! Ganó Pareja ${sala.puntos[0] >= 40 ? 1 : 2}`);
    return;
  }
  const orden = ['grande', 'chica', 'pares', 'juego'];
  let idx = orden.indexOf(sala.fase);
  if (idx !== -1 && idx < orden.length - 1) {
    iniciarRonda(orden[idx + 1]);
  } else {
    iniciarMano();
  }
}

io.on('connection', (socket) => {
  const ocupados = Object.values(sala.jugadores).map(j => j.asiento);
  let asientoLibre = [0, 1, 2, 3].find(a => !ocupados.includes(a));

  if (asientoLibre !== undefined) {
    sala.jugadores[socket.id] = { asiento: asientoLibre, nombre: ASIENTOS[asientoLibre].nombre, esBot: false };
    socket.emit('asientoAsignado', { asiento: asientoLibre, info: ASIENTOS[asientoLibre] });
  } else {
    socket.emit('mesaLlena');
  }

  notificarEstado(`${sala.jugadores[socket.id]?.nombre || 'Espectador'} conectado.`);

  if (Object.keys(sala.jugadores).length === 4 && !sala.enPartida) {
    iniciarMano();
  }

  socket.on('rellenarBots', () => {
    const ocupadosAhora = Object.values(sala.jugadores).map(j => j.asiento);
    [0, 1, 2, 3].forEach(a => {
      if (!ocupadosAhora.includes(a)) {
        const idBot = `bot_${a}`;
        sala.jugadores[idBot] = { asiento: a, nombre: `🤖 Bot ${a + 1}`, esBot: true };
      }
    });
    notificarEstado("Huecos rellenados con Bots.");
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
      iniciarRonda('grande');
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
    delete sala.jugadores[socket.id];
    sala.enPartida = false;
    notificarEstado("Un jugador salió.");
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));