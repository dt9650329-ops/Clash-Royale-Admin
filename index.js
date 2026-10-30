// Consulta el perfil de un jugador de Clash Royale por su tag.
// Se llama desde el front con firebase.functions().httpsCallable("consultarJugador").
// Secreto: CR_API_KEY (firebase functions:secrets:set CR_API_KEY)

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

const CR_API_KEY = defineSecret("CR_API_KEY");
const CR_BASE = "https://proxy.royaleapi.dev/v1";

admin.initializeApp({ databaseURL: "https://clash-royale-9e27b-default-rtdb.firebaseio.com" });
const db = admin.database();
const TIPOS_AMISTOSOS = ["friendly", "clanMate"];
const ESPERA_MS = 20 * 1000; // mínimo entre revisiones, para no saturar la API

exports.consultarJugador = onCall({ secrets: [CR_API_KEY] }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Inicia sesión para continuar");
  }

  const tag = String((request.data || {}).tag || "")
    .trim()
    .toUpperCase()
    .replace(/^#/, "");
  if (!/^[0289PYLQGRJCUV]{3,15}$/.test(tag)) {
    throw new HttpsError("invalid-argument", "Ese tag no es válido. Revisa que lo copiaste completo");
  }

  const r = await fetch(`${CR_BASE}/players/%23${tag}`, {
    headers: { Authorization: `Bearer ${CR_API_KEY.value()}` },
  });
  if (r.status === 404) {
    throw new HttpsError("not-found", "No encontramos ese tag en Clash Royale");
  }
  if (!r.ok) {
    throw new HttpsError("unavailable", "Clash Royale no respondió. Intenta de nuevo en un momento");
  }

  const p = await r.json();
  return {
    tag: p.tag,
    nombre: p.name,
    nivel: p.expLevel,
    copas: p.trophies,
    mejoresCopas: p.bestTrophies,
    victorias: p.wins,
    derrotas: p.losses,
    clan: p.clan ? p.clan.name : null,
    arena: p.arena ? p.arena.name : null,
  };
});

// Revisa las batallas amistosas entre jugadores de la tabla y actualiza historial y victorias.
exports.actualizarTorneo = onCall({ secrets: [CR_API_KEY] }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Inicia sesión para continuar");
  }

  const refMeta = db.ref("torneo/ultimaActualizacion");
  const ultima = (await refMeta.once("value")).val() || 0;
  if (Date.now() - ultima < ESPERA_MS) return { nuevas: 0, omitido: true };
  await refMeta.set(Date.now());

  const [snapJug, snapHist] = await Promise.all([
    db.ref("jugadores").once("value"),
    db.ref("historial").once("value"),
  ]);

  const jugadores = {}; // tag sin # -> { uid, nombre, creadoEn }
  snapJug.forEach((h) => {
    const j = h.val();
    if (j && j.tag) {
      jugadores[j.tag.replace(/^#/, "")] = { uid: h.key, nombre: j.nombreClash || j.nombre || "Jugador", creadoEn: j.creadoEn || 0 };
    }
  });
  const tags = Object.keys(jugadores);
  const historial = snapHist.val() || {};

  const logs = await Promise.allSettled(tags.map(async (t) => {
    const r = await fetch(`${CR_BASE}/players/%23${t}/battlelog`, {
      headers: { Authorization: `Bearer ${CR_API_KEY.value()}` },
    });
    if (!r.ok) throw new Error("battlelog " + r.status);
    return r.json();
  }));
  if (tags.length && logs.every((l) => l.status === "rejected")) {
    throw new HttpsError("unavailable", "Clash Royale no respondió. Intenta de nuevo en un momento");
  }

  const nuevas = {};
  logs.forEach((l) => {
    if (l.status !== "fulfilled" || !Array.isArray(l.value)) return;
    l.value.forEach((b) => {
      if (!TIPOS_AMISTOSOS.includes(b.type)) return;
      if (!b.team || !b.opponent || b.team.length !== 1 || b.opponent.length !== 1) return; // solo 1v1
      const a = b.team[0];
      const c = b.opponent[0];
      const ta = String(a.tag).replace(/^#/, "");
      const tc = String(c.tag).replace(/^#/, "");
      const ja = jugadores[ta];
      const jc = jugadores[tc];
      if (!ja || !jc || ta === tc) return;   // ambos deben estar en la tabla
      if (a.crowns === c.crowns) return;     // empate: no cuenta
      const m = String(b.battleTime).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
      if (!m) return;
      const fecha = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
      if (fecha < Math.max(ja.creadoEn, jc.creadoEn)) return; // solo batallas posteriores al registro de ambos
      const id = m.slice(1).join("") + "_" + [ta, tc].sort().join("_"); // misma batalla = mismo id
      if (historial[id] || nuevas[id]) return;
      const gana = a.crowns > c.crowns;
      const [g, p, cg, cp] = gana ? [ja, jc, a.crowns, c.crowns] : [jc, ja, c.crowns, a.crowns];
      nuevas[id] = {
        fecha,
        ganadorUid: g.uid, ganadorNombre: g.nombre,
        perdedorUid: p.uid, perdedorNombre: p.nombre,
        coronasGanador: cg, coronasPerdedor: cp,
      };
    });
  });

  // Victorias recalculadas desde el historial completo (no se duplican nunca)
  const victorias = {};
  Object.values(Object.assign({}, historial, nuevas)).forEach((h) => {
    victorias[h.ganadorUid] = (victorias[h.ganadorUid] || 0) + 1;
  });

  const ahora = Date.now();
  const cambios = {};
  Object.entries(nuevas).forEach(([id, h]) => { cambios["historial/" + id] = h; });
  tags.forEach((t) => {
    const uid = jugadores[t].uid;
    cambios[`jugadores/${uid}/victorias`] = victorias[uid] || 0;
    cambios[`jugadores/${uid}/ultimaActualizacion`] = ahora;
  });
  await db.ref().update(cambios);

  return { nuevas: Object.keys(nuevas).length };
});

// ---------- Cuadrar partida: retos con créditos ----------
// Los créditos se descuentan al publicar/aceptar (quedan reservados) y se devuelven si el reto se cancela o vence.
const MONTO_MIN = 5, MONTO_MAX = 100000;     // mínimo 5 créditos (la tienda vende 10, 25 y 50)
const VIGENCIA_YA_MS = 5 * 60 * 1000;        // un reto "Jugar ya" dura 5 minutos
const MAX_ABIERTOS = 3;                      // retos abiertos por jugador
// 🧪 MODO PRUEBAS: cada cuenta recibe créditos de prueba (una sola vez) para poder cuadrar partidas sin pasar por el admin.
// Antes de salir a producción pon MODO_PRUEBAS = false y vuelve a desplegar: deja de regalar créditos.
const MODO_PRUEBAS = true;
const CREDITOS_PRUEBA = 1000000;
const R = (p) => db.ref(p);

function sesion(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión para continuar");
  return request.auth.uid;
}

// Sube el saldo a CREDITOS_PRUEBA una sola vez por cuenta (si ya tenía más, no se le quita nada).
async function asegurarCreditosPrueba(uid) {
  if (!MODO_PRUEBAS) return false;
  const r = await R(`wallets/${uid}`).transaction((w) => {
    w = w || {};
    if (w.pruebaOtorgada) return;   // ya se le dieron: no cambia nada
    return Object.assign(w, { creditos: Math.max(w.creditos || 0, CREDITOS_PRUEBA), pruebaOtorgada: Date.now() });
  });
  return r.committed;
}

async function debitar(uid, monto) {
  await asegurarCreditosPrueba(uid);
  let descontado = false;
  const r = await R(`wallets/${uid}/creditos`).transaction((c) => {
    descontado = false;
    if (c === null) return 0;   // fuerza a Firebase a reintentar con el valor real
    if (c < monto) return;      // sin saldo: aborta
    descontado = true;
    return c - monto;
  });
  // Si el saldo realmente no existía, el "return 0" se guarda pero NO se descontó nada: eso no cuenta como pago.
  if (!r.committed || !descontado) throw new HttpsError("failed-precondition", "No tienes créditos suficientes");
}
const acreditar = (uid, monto) => R(`wallets/${uid}/creditos`).transaction((c) => (c || 0) + monto);

async function perfilJugador(uid) {
  const j = (await R(`jugadores/${uid}`).once("value")).val() || {};
  if (!j.tag) throw new HttpsError("failed-precondition", "Vincula tu tag de Clash Royale primero");
  return { nombre: j.nombreClash || j.nombre || "Jugador", tag: j.tag };
}

// Cambia el estado de un reto de forma atómica; devuelve el reto actualizado o null si no cumplía la condición.
async function cambiarReto(id, condicion, mutar) {
  const r = await R(`retos/${id}`).transaction((x) => {
    if (x === null) return x;
    if (!condicion(x)) return;
    return mutar(x);
  });
  return r.committed && r.snapshot.exists() ? r.snapshot.val() : null;
}

exports.crearReto = onCall(async (request) => {
  const uid = sesion(request);
  const d = request.data || {};
  const monto = Number(d.monto);
  if (!Number.isInteger(monto) || monto < MONTO_MIN || monto > MONTO_MAX) {
    throw new HttpsError("invalid-argument", `El monto debe ser entero, entre ${MONTO_MIN} y ${MONTO_MAX}`);
  }
  const ahora = Date.now();
  let cuando = null;
  let vence = ahora + VIGENCIA_YA_MS;
  if (d.modo === "programado") {
    cuando = Number(d.cuando);
    if (!Number.isFinite(cuando) || cuando < ahora + 2 * 60 * 1000 || cuando > ahora + 7 * 24 * 3600 * 1000) {
      throw new HttpsError("invalid-argument", "Elige una hora entre 2 minutos y 7 días desde ahora");
    }
    vence = cuando;
  } else if (d.modo !== "ya") {
    throw new HttpsError("invalid-argument", "Modo no válido");
  }
  const yo = await perfilJugador(uid);
  const mios = await R("retos").orderByChild("creadorUid").equalTo(uid).once("value");
  let abiertos = 0;
  mios.forEach((h) => { const x = h.val(); if (x.estado === "abierto" && x.vence > ahora) abiertos++; });
  if (abiertos >= MAX_ABIERTOS) throw new HttpsError("resource-exhausted", `Máximo ${MAX_ABIERTOS} retos abiertos a la vez`);

  await debitar(uid, monto);
  try {
    const nuevo = R("retos").push();
    await nuevo.set({ creadorUid: uid, creadorNombre: yo.nombre, creadorTag: yo.tag, monto, modo: d.modo, cuando, vence, estado: "abierto", creadoEn: ahora });
    return { id: nuevo.key };
  } catch (e) {
    await acreditar(uid, monto);
    throw new HttpsError("internal", "No se pudo publicar el reto");
  }
});

exports.aceptarReto = onCall(async (request) => {
  const uid = sesion(request);
  const id = String((request.data || {}).retoId || "");
  if (!id) throw new HttpsError("invalid-argument", "Falta el reto");
  const yo = await perfilJugador(uid);
  const previo = (await R(`retos/${id}`).once("value")).val();
  if (!previo) throw new HttpsError("not-found", "Ese reto ya no existe");
  if (previo.creadorUid === uid) throw new HttpsError("failed-precondition", "No puedes aceptar tu propio reto");

  await debitar(uid, previo.monto);
  const r = await cambiarReto(
    id,
    (x) => x.estado === "abierto" && x.vence > Date.now() && x.creadorUid !== uid && x.monto === previo.monto,
    (x) => Object.assign(x, { estado: "aceptado", rivalUid: uid, rivalNombre: yo.nombre, rivalTag: yo.tag, aceptadoEn: Date.now() })
  );
  if (!r) {
    await acreditar(uid, previo.monto);
    throw new HttpsError("failed-precondition", "Ese reto ya no está disponible");
  }
  return { ok: true };
});

exports.cancelarReto = onCall(async (request) => {
  const uid = sesion(request);
  const id = String((request.data || {}).retoId || "");
  const r = await cambiarReto(id, (x) => x.estado === "abierto" && x.creadorUid === uid, (x) => Object.assign(x, { estado: "cancelado" }));
  if (!r) throw new HttpsError("failed-precondition", "Este reto ya no se puede cancelar");
  await acreditar(uid, r.monto);
  return { ok: true };
});

// Devuelve los créditos de los retos abiertos que ya vencieron sin rival.
exports.expirarRetos = onCall(async (request) => {
  sesion(request);
  const snap = await R("retos").orderByChild("estado").equalTo("abierto").once("value");
  const ahora = Date.now();
  let n = 0;
  for (const [id, x] of Object.entries(snap.val() || {})) {
    if (x.vence > ahora) continue;
    const r = await cambiarReto(id, (y) => y.estado === "abierto" && y.vence <= Date.now(), (y) => Object.assign(y, { estado: "expirado" }));
    if (r) { await acreditar(r.creadorUid, r.monto); n++; }
  }
  return { expirados: n };
});

// La app la llama al iniciar sesión: en modo pruebas la cuenta queda con 1.000.000 de créditos.
exports.creditosPrueba = onCall(async (request) => {
  const uid = sesion(request);
  const otorgado = await asegurarCreditosPrueba(uid);
  const creditos = (await R(`wallets/${uid}/creditos`).once("value")).val() || 0;
  return { otorgado, creditos, pruebas: MODO_PRUEBAS };
});

// ---------- Resultado de la partida: el que gana se lleva el pozo ----------
// Al publicar y al aceptar, cada jugador ya tiene su monto reservado (descontado). Cuando se juega una batalla AMISTOSA 1v1 entre los dos
// tags, se lee el resultado en Clash Royale y el ganador recibe el pozo (los dos montos). Empate o si nadie juega a tiempo: se devuelve a cada uno lo suyo.
const PLAZO_JUGAR_MS = 60 * 60 * 1000;   // tiempo para jugar después de aceptar (o de la hora programada)
const COMISION_PCT = 0;                  // % del pozo que se queda la casa (0 = ninguno)

const fechaBatalla = (bt) => {
  const m = String(bt).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : 0;
};
const sinNumeral = (t) => String(t || "").replace(/^#/, "");

// Suma créditos UNA sola vez por 'clave' (si se repite el proceso, no vuelve a pagar).
async function pagarUnaVez(uid, clave, monto) {
  if (!(monto > 0)) return;
  await R(`wallets/${uid}`).transaction((w) => {
    w = w || {};
    w.pagos = w.pagos || {};
    if (w.pagos[clave]) return;
    w.pagos[clave] = Date.now();
    w.creditos = (w.creditos || 0) + monto;
    return w;
  });
}

const ESTADO_FINAL = { ganado: "finalizado", empate: "empate", sin_jugar: "sin_jugar" };

// Paga según el resultado ya decidido y deja el reto en su estado final. Se puede repetir sin riesgo de pagar dos veces.
async function terminarLiquidacion(id, r) {
  const res = r.resultado || { tipo: "sin_jugar" };
  const pozo = r.monto * 2;
  const premio = pozo - Math.floor((pozo * COMISION_PCT) / 100);
  if (res.tipo === "ganado") {
    await pagarUnaVez(res.ganadorUid, id, premio);
  } else {
    await pagarUnaVez(r.creadorUid, id + "_a", r.monto);
    await pagarUnaVez(r.rivalUid, id + "_b", r.monto);
  }
  if (res.batalla) await R(`torneo/liquidadas/${res.batalla}`).set(id);
  await cambiarReto(id, (x) => x.estado === "liquidando", (x) => Object.assign(x, { estado: ESTADO_FINAL[res.tipo] || "sin_jugar", premio: res.tipo === "ganado" ? premio : 0, terminadoEn: Date.now() }));
}

// Busca en las batallas del creador la primera amistosa 1v1 contra el rival, posterior a la aceptación, que no se haya usado antes.
function buscarBatalla(r, batallas, usadas, ahora) {
  const ta = sinNumeral(r.creadorTag), tb = sinNumeral(r.rivalTag);
  const desde = Math.max(r.aceptadoEn || 0, r.modo === "programado" ? (r.cuando || 0) - 10 * 60 * 1000 : 0);
  return (batallas || [])
    .filter((b) => TIPOS_AMISTOSOS.includes(b.type) && b.team && b.opponent && b.team.length === 1 && b.opponent.length === 1
      && sinNumeral(b.team[0].tag) === ta && sinNumeral(b.opponent[0].tag) === tb)
    .map((b) => ({ b, fecha: fechaBatalla(b.battleTime) }))
    .filter((x) => x.fecha >= desde && x.fecha <= ahora + 60 * 1000 && !usadas[`${x.fecha}_${[ta, tb].sort().join("_")}`])
    .sort((x, y) => x.fecha - y.fecha)
    .map((x) => ({ b: x.b, fecha: x.fecha, id: `${x.fecha}_${[ta, tb].sort().join("_")}` }))[0] || null;
}

exports.liquidarRetos = onCall({ secrets: [CR_API_KEY] }, async (request) => {
  sesion(request);
  const ahora = Date.now();

  // 1) Termina las liquidaciones que quedaron a medias
  const medio = (await R("retos").orderByChild("estado").equalTo("liquidando").once("value")).val() || {};
  for (const [id, x] of Object.entries(medio)) {
    if (ahora - (x.liquidandoEn || 0) > 60 * 1000) await terminarLiquidacion(id, x);
  }

  // 2) No saturar la API de Clash Royale: una revisión cada ESPERA_MS para todos
  const refMeta = R("torneo/ultimaLiquidacion");
  if (ahora - ((await refMeta.once("value")).val() || 0) < ESPERA_MS) return { liquidados: 0, omitido: true };
  await refMeta.set(ahora);

  const aceptados = Object.entries((await R("retos").orderByChild("estado").equalTo("aceptado").once("value")).val() || {}).slice(0, 15);
  if (!aceptados.length) return { liquidados: 0 };
  const usadas = (await R("torneo/liquidadas").once("value")).val() || {};

  const tags = [...new Set(aceptados.map(([, r]) => sinNumeral(r.creadorTag)))];
  const logs = {};
  await Promise.all(tags.map(async (t) => {
    try {
      const resp = await fetch(`${CR_BASE}/players/%23${t}/battlelog`, { headers: { Authorization: `Bearer ${CR_API_KEY.value()}` } });
      if (resp.ok) logs[t] = await resp.json();
    } catch (e) { /* se reintenta en la siguiente revisión */ }
  }));

  let liquidados = 0;
  for (const [id, r] of aceptados) {
    const batallas = logs[sinNumeral(r.creadorTag)];
    if (!Array.isArray(batallas)) continue;   // sin datos de Clash Royale: no se decide nada
    const hallada = buscarBatalla(r, batallas, usadas, ahora);
    let resultado = null;
    if (hallada) {
      const a = hallada.b.team[0], c = hallada.b.opponent[0];
      if (a.crowns === c.crowns) {
        resultado = { tipo: "empate", batalla: hallada.id, fecha: hallada.fecha };
      } else {
        const creadorGana = a.crowns > c.crowns;
        resultado = {
          tipo: "ganado", batalla: hallada.id, fecha: hallada.fecha,
          ganadorUid: creadorGana ? r.creadorUid : r.rivalUid, perdedorUid: creadorGana ? r.rivalUid : r.creadorUid,
          coronasGanador: Math.max(a.crowns, c.crowns), coronasPerdedor: Math.min(a.crowns, c.crowns),
        };
      }
    } else if (ahora > Math.max(r.aceptadoEn || 0, r.modo === "programado" ? (r.cuando || 0) : 0) + PLAZO_JUGAR_MS) {
      resultado = { tipo: "sin_jugar" };
    }
    if (!resultado) continue;
    const tomado = await cambiarReto(id, (x) => x.estado === "aceptado", (x) => Object.assign(x, { estado: "liquidando", liquidandoEn: Date.now(), resultado }));
    if (!tomado) continue;   // otro proceso ya lo tomó
    await terminarLiquidacion(id, tomado);
    if (resultado.batalla) usadas[resultado.batalla] = id;
    liquidados++;
  }
  return { liquidados };
});

// ================== PANEL DE ADMINISTRACIÓN ==================
// Solo pueden usar estas funciones las cuentas de Google de esta lista.
const ADMINS_CORREOS = ["dt9650329@gmail.com"];

function soloAdmin(request) {
  const uid = sesion(request);
  const t = request.auth.token || {};
  const lista = ADMINS_CORREOS.map((c) => c.toLowerCase());
  if (!t.email_verified || !lista.includes(String(t.email || "").toLowerCase())) {
    throw new HttpsError("permission-denied", "Esta cuenta no es administradora");
  }
  return { uid, correo: t.email };
}

const logAdmin = (adm, datos) =>
  R("adminLog").push(Object.assign({ fecha: Date.now(), admin: adm.correo }, datos));

// Todas las cuentas que han entrado (con o sin registro completo), con saldo y victorias.
exports.adminListar = onCall(async (request) => {
  soloAdmin(request);
  const [sU, sJ, sW] = await Promise.all([R("users").once("value"), R("jugadores").once("value"), R("wallets").once("value")]);
  const users = sU.val() || {}, jug = sJ.val() || {}, wal = sW.val() || {};

  const auth = {};
  let token;
  do {
    const pagina = await admin.auth().listUsers(1000, token);
    pagina.users.forEach((u) => { auth[u.uid] = u; });
    token = pagina.pageToken;
  } while (token && Object.keys(auth).length < 5000);

  const admins = ADMINS_CORREOS.map((c) => c.toLowerCase());
  const uids = new Set([...Object.keys(users), ...Object.keys(auth)]);
  const cuentas = [...uids].map((uid) => {
    const u = users[uid] || {}, a = auth[uid], j = jug[uid] || {}, w = wal[uid] || {};
    const correo = u.correo || (a && a.email) || "";
    return {
      uid,
      nombre: u.nombre || (a && a.displayName) || "",
      correo,
      telefono: u.telefono || "",
      tag: u.tag || j.tag || "",
      enlace: u.enlace || j.enlace || "",
      registrado: !!users[uid],
      creadoEn: u.creadoEn || (a ? Date.parse(a.metadata.creationTime) : 0) || 0,
      ultimoIngreso: a ? Date.parse(a.metadata.lastSignInTime) || 0 : 0,
      creditos: w.creditos || 0,
      victorias: j.victorias || 0,
      suspendido: !!(a && a.disabled),
      esAdmin: admins.includes(correo.toLowerCase()),
    };
  });
  return { cuentas };
});

// Suma, resta o fija el saldo de una cuenta. Queda anotado en el registro.
exports.adminCreditos = onCall(async (request) => {
  const adm = soloAdmin(request);
  const d = request.data || {};
  const uid = String(d.uid || "");
  const modo = d.modo;
  const monto = Number(d.monto);
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(uid)) throw new HttpsError("invalid-argument", "Cuenta no válida");
  if (!["sumar", "restar", "fijar"].includes(modo)) throw new HttpsError("invalid-argument", "Acción no válida");
  if (!Number.isInteger(monto) || monto < (modo === "fijar" ? 0 : 1) || monto > 100000000) {
    throw new HttpsError("invalid-argument", "El monto debe ser un número entero válido");
  }
  const motivo = String(d.motivo || "").slice(0, 120);

  try { await admin.auth().getUser(uid); } catch (e) { throw new HttpsError("not-found", "Esa cuenta no existe"); }

  let antes = 0, despues = 0, sinSaldo = false, vistoReal = false;
  const r = await R(`wallets/${uid}`).transaction((w) => {
    sinSaldo = false;
    if (w === null && modo === "restar") return { creditos: 0 }; // fuerza a Firebase a reintentar con el saldo real
    if (w !== null) vistoReal = true;
    w = w || {};
    antes = w.creditos || 0;
    despues = modo === "sumar" ? antes + monto : modo === "restar" ? antes - monto : monto;
    if (despues < 0) { sinSaldo = true; return; }
    w.creditos = despues;
    if (!w.pruebaOtorgada) w.pruebaOtorgada = Date.now(); // el saldo manual no se pisa con los créditos de prueba
    return w;
  });
  if (!r.committed || (modo === "restar" && !vistoReal)) {
    throw new HttpsError("failed-precondition", sinSaldo || modo === "restar" ? "La cuenta no tiene tantos créditos para restar" : "No se pudo actualizar el saldo");
  }
  await logAdmin(adm, { uid, accion: modo, monto, antes, despues, motivo });
  return { antes, creditos: despues };
});

// Suspende o reactiva una cuenta (bloquea el inicio de sesión de Firebase Auth).
exports.adminEstado = onCall(async (request) => {
  const adm = soloAdmin(request);
  const d = request.data || {};
  const uid = String(d.uid || "");
  const suspender = !!d.suspender;
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(uid)) throw new HttpsError("invalid-argument", "Cuenta no válida");
  if (uid === adm.uid) throw new HttpsError("failed-precondition", "No puedes suspender tu propia cuenta");
  let u;
  try { u = await admin.auth().getUser(uid); } catch (e) { throw new HttpsError("not-found", "Esa cuenta no existe"); }
  if (ADMINS_CORREOS.map((c) => c.toLowerCase()).includes(String(u.email || "").toLowerCase())) {
    throw new HttpsError("failed-precondition", "No se puede suspender a otro administrador");
  }
  await admin.auth().updateUser(uid, { disabled: suspender });
  if (suspender) await admin.auth().revokeRefreshTokens(uid);
  await logAdmin(adm, { uid, accion: suspender ? "suspender" : "reactivar" });
  return { suspendido: suspender };
});

// Últimas 50 acciones del panel.
exports.adminRegistro = onCall(async (request) => {
  soloAdmin(request);
  const s = await R("adminLog").limitToLast(50).once("value");
  const registros = [];
  s.forEach((h) => { registros.push(Object.assign({ id: h.key }, h.val())); });
  return { registros: registros.reverse() };
});

// ================== TIENDA DE MONEDAS ==================
// El cobro se confirma a mano: el jugador solicita, el admin verifica el pago y acredita.
// Precios en PESOS COLOMBIANOS (COP). Cámbialos aquí y en el mismo PAQUETES del index.html del jugador.
const PAQUETES = { p10: { creditos: 10, pesos: 5000 }, p25: { creditos: 25, pesos: 12500 }, p50: { creditos: 50, pesos: 25000 } };
const MAX_PENDIENTES = 3;

exports.solicitarCompra = onCall(async (request) => {
  const uid = sesion(request);
  const paquete = String((request.data || {}).paquete || "");
  const p = PAQUETES[paquete];
  if (!p) throw new HttpsError("invalid-argument", "Paquete no válido");

  const previas = (await R(`comprasUsuario/${uid}`).limitToLast(30).once("value")).val() || {};
  if (Object.values(previas).filter((c) => c.estado === "pendiente").length >= MAX_PENDIENTES) {
    throw new HttpsError("resource-exhausted", `Ya tienes ${MAX_PENDIENTES} solicitudes pendientes. Espera a que el administrador las confirme`);
  }
  const u = await admin.auth().getUser(uid);
  const j = (await R(`jugadores/${uid}`).once("value")).val() || {};
  const id = R("compras").push().key;
  const fecha = Date.now();
  await db.ref().update({
    [`compras/${id}`]: { uid, nombre: j.nombre || u.displayName || "", correo: u.email || "", tag: j.tag || "", paquete, creditos: p.creditos, pesos: p.pesos, estado: "pendiente", fecha },
    [`comprasUsuario/${uid}/${id}`]: { creditos: p.creditos, pesos: p.pesos, estado: "pendiente", fecha },
  });
  return { id };
});

exports.misCompras = onCall(async (request) => {
  const uid = sesion(request);
  const s = await R(`comprasUsuario/${uid}`).limitToLast(20).once("value");
  const lista = [];
  s.forEach((h) => { lista.push(Object.assign({ id: h.key }, h.val())); });
  return lista.reverse();
});

exports.adminCompras = onCall(async (request) => {
  soloAdmin(request);
  const s = await R("compras").limitToLast(100).once("value");
  const compras = [];
  s.forEach((h) => { compras.push(Object.assign({ id: h.key }, h.val())); });
  return { compras: compras.reverse() };
});

// Aprueba (acredita los créditos) o rechaza una solicitud pendiente.
exports.adminResolverCompra = onCall(async (request) => {
  const adm = soloAdmin(request);
  const d = request.data || {};
  const id = String(d.id || "");
  const aprobar = d.aprobar === true;
  if (!/^[A-Za-z0-9_-]{10,40}$/.test(id)) throw new HttpsError("invalid-argument", "Solicitud no válida");

  // 1) Reclamar la solicitud de forma atómica: así no se acredita dos veces.
  const r = await R(`compras/${id}`).transaction((c) => {
    if (c === null) return c;
    if (c.estado !== "pendiente") return;
    c.estado = aprobar ? "procesando" : "rechazada";
    c.resueltaPor = adm.correo;
    c.resueltaEn = Date.now();
    return c;
  });
  if (!r.committed || !r.snapshot.exists()) throw new HttpsError("failed-precondition", "Esa solicitud no existe o ya fue resuelta");
  const c = r.snapshot.val();

  // 2) Acreditar y cerrar.
  if (aprobar) {
    await R(`wallets/${c.uid}`).transaction((w) => {
      w = w || {};
      w.creditos = (w.creditos || 0) + c.creditos;
      if (!w.pruebaOtorgada) w.pruebaOtorgada = Date.now();
      return w;
    });
    await R(`compras/${id}/estado`).set("aprobada");
  }
  await R(`comprasUsuario/${c.uid}/${id}/estado`).set(aprobar ? "aprobada" : "rechazada");
  await logAdmin(adm, { uid: c.uid, accion: aprobar ? "compra" : "compra-rechazada", monto: c.creditos, motivo: c.pesos != null ? `$${c.pesos} COP` : `$${c.usd} USD` });
  return { estado: aprobar ? "aprobada" : "rechazada" };
});

// ================== RETIROS ==================
// Mismos 3 valores de la tienda (10, 25 y 50 créditos). Del valor en pesos se descuenta la comisión de retiro.
// Los créditos se descuentan al PEDIR el retiro (quedan retenidos y no se pueden apostar) y se devuelven si el admin lo rechaza.
// El pago en sí lo hace el admin por fuera (Nequi, PayPal, etc.) y luego lo marca como pagado en el panel.
const COMISION_RETIRO_PCT = 20;
const MAX_RETIROS_PENDIENTES = 3;

function calcularRetiro(pesos) {
  const comisionPesos = Math.round((pesos * COMISION_RETIRO_PCT) / 100);
  return { comisionPesos, recibePesos: pesos - comisionPesos };
}

exports.solicitarRetiro = onCall(async (request) => {
  const uid = sesion(request);
  const d = request.data || {};
  const p = PAQUETES[String(d.paquete || "")];
  if (!p) throw new HttpsError("invalid-argument", "Paquete no válido");
  const destino = String(d.destino || "").replace(/\s+/g, " ").trim();
  if (destino.length < 5 || destino.length > 120) {
    throw new HttpsError("invalid-argument", "Escribe dónde quieres recibir el pago (entre 5 y 120 caracteres)");
  }

  const previos = (await R(`retirosUsuario/${uid}`).limitToLast(30).once("value")).val() || {};
  if (Object.values(previos).filter((c) => c.estado === "pendiente" || c.estado === "devolviendo").length >= MAX_RETIROS_PENDIENTES) {
    throw new HttpsError("resource-exhausted", `Ya tienes ${MAX_RETIROS_PENDIENTES} retiros pendientes. Espera a que el administrador los pague`);
  }

  const [u, perfil, j] = await Promise.all([
    admin.auth().getUser(uid),
    R(`users/${uid}`).once("value").then((s) => s.val() || {}),
    R(`jugadores/${uid}`).once("value").then((s) => s.val() || {}),
  ]);
  const { comisionPesos, recibePesos } = calcularRetiro(p.pesos);

  await debitar(uid, p.creditos);   // lanza "No tienes créditos suficientes" si no alcanza
  const id = R("retiros").push().key;
  const fecha = Date.now();
  try {
    await db.ref().update({
      [`retiros/${id}`]: {
        uid, nombre: perfil.nombre || j.nombre || u.displayName || "", correo: u.email || "", telefono: perfil.telefono || "", tag: j.tag || "",
        paquete: String(d.paquete), creditos: p.creditos, pesos: p.pesos, comisionPct: COMISION_RETIRO_PCT, comisionPesos, recibePesos, destino,
        estado: "pendiente", fecha,
      },
      [`retirosUsuario/${uid}/${id}`]: { creditos: p.creditos, pesos: p.pesos, recibePesos, estado: "pendiente", fecha },
    });
  } catch (e) {
    await acreditar(uid, p.creditos);   // si no se pudo registrar, los créditos vuelven al jugador
    throw new HttpsError("internal", "No se pudo registrar el retiro. Tus créditos siguen en tu cuenta");
  }
  return { id, recibePesos };
});

exports.misRetiros = onCall(async (request) => {
  const uid = sesion(request);
  const s = await R(`retirosUsuario/${uid}`).limitToLast(20).once("value");
  const lista = [];
  s.forEach((h) => { lista.push(Object.assign({ id: h.key }, h.val())); });
  return lista.reverse();
});

exports.adminRetiros = onCall(async (request) => {
  soloAdmin(request);
  const s = await R("retiros").limitToLast(100).once("value");
  const retiros = [];
  s.forEach((h) => { retiros.push(Object.assign({ id: h.key }, h.val())); });
  return { retiros: retiros.reverse() };
});

// pagar = true  -> el admin ya envió el dinero: queda "pagado".
// pagar = false -> se rechaza y se devuelven los créditos al jugador (una sola vez).
exports.adminResolverRetiro = onCall(async (request) => {
  const adm = soloAdmin(request);
  const d = request.data || {};
  const id = String(d.id || "");
  const pagar = d.pagar === true;
  const nota = String(d.nota || "").trim().slice(0, 120);
  if (!/^[A-Za-z0-9_-]{10,40}$/.test(id)) throw new HttpsError("invalid-argument", "Retiro no válido");

  const r = await R(`retiros/${id}`).transaction((c) => {
    if (c === null) return c;
    // un rechazo que quedó a medias ("devolviendo") se puede reintentar
    if (c.estado !== "pendiente" && !(c.estado === "devolviendo" && !pagar)) return;
    c.estado = pagar ? "pagado" : "devolviendo";
    c.resueltoPor = adm.correo;
    c.resueltoEn = Date.now();
    if (nota) c.nota = nota;
    return c;
  });
  if (!r.committed || !r.snapshot.exists()) throw new HttpsError("failed-precondition", "Ese retiro no existe o ya fue resuelto");
  const c = r.snapshot.val();

  if (!pagar) {
    await pagarUnaVez(c.uid, "retiro_" + id, c.creditos);
    await R(`retiros/${id}/estado`).set("rechazado");
  }
  await R(`retirosUsuario/${c.uid}/${id}/estado`).set(pagar ? "pagado" : "rechazado");
  await logAdmin(adm, { uid: c.uid, accion: pagar ? "retiro" : "retiro-rechazado", monto: c.creditos, motivo: (c.recibePesos != null ? `$${c.recibePesos} COP` : `$${c.recibeUsd} USD`) + ` · ${c.destino}`.slice(0, 120) });
  return { estado: pagar ? "pagado" : "rechazado" };
});

// Devuelve solos (cada minuto) los créditos de los retos que vencieron sin rival. Archivo: functions/expiracion.js
Object.assign(exports, require("./expiracion"));
