"use strict";

const path = require("path");
const crypto = require("crypto");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const express = require("express");
const cors = require("cors");
const sql = require("mssql/msnodesqlv8");

const PORT = Number(process.env.PORT || 3000);

const config = {
  connectionString:
    (typeof process.env.DB_CONNECTION_STRING === "string" && process.env.DB_CONNECTION_STRING.trim()) ||
    [
      "Driver={ODBC Driver 18 for SQL Server}",
      "Server=localhost",
      "Database=marketing_db",
      "Trusted_Connection=yes",
      "TrustServerCertificate=yes",
    ].join(";"),
};

let poolPromise;
async function ensureUsersProfileJsonColumn(pool) {
  try {
    await pool.request().query(`
IF NOT EXISTS (
  SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = SCHEMA_NAME() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'profile_json'
)
ALTER TABLE users ADD profile_json NVARCHAR(MAX) NULL;
`);
    console.log("Columna profile_json disponible en users (nombre, cargo, foto vía login).");
  } catch (e) {
    console.warn(
      "No se pudo asegurar la columna profile_json en dbo.users:",
      e?.message || e,
      "(el login puede no devolver nombre completo)."
    );
  }
}
function getPool() {
  if (!poolPromise) {
    poolPromise = sql.connect(config).then(async (pool) => {
      console.log("Conectado a SQL Server correctamente");
      await ensureUsersProfileJsonColumn(pool);
      return pool;
    });
  }
  return poolPromise;
}

/** Misma fórmula que `campatrackHashPassword` en el cliente (SHA-256 hex sobre `usuario\\nclave`). */
function hashCampatrackPassword(username, plainPassword) {
  const base = `${String(username || "").trim()}\n${String(plainPassword)}`;
  return crypto.createHash("sha256").update(base, "utf8").digest("hex");
}

/** IDs de equipo permitidos en login y perfiles (coinciden con el cliente CampaTrack). */
const CAMPATRACK_TEAM_IDS = ["team_maestrias", "team_edex"];
const CAMPATRACK_TEAM_ID_SET = new Set(CAMPATRACK_TEAM_IDS);

function normalizeTeamsFromStoredProfile(profileLike) {
  let arr = [];
  if (profileLike && Array.isArray(profileLike.teams)) {
    for (const x of profileLike.teams) {
      const k = String(x || "").trim();
      if (CAMPATRACK_TEAM_ID_SET.has(k)) arr.push(k);
    }
  }
  arr = [...new Set(arr)];
  if (
    !arr.length &&
    profileLike &&
    typeof profileLike.teamId === "string"
  ) {
    const t = profileLike.teamId.trim();
    if (CAMPATRACK_TEAM_ID_SET.has(t)) arr = [t];
  }
  return arr;
}

/** Devuelve el bundle como objeto o null (acepta objeto publicado o JSON string). */
function parseBundleLikeObject(data) {
  if (data == null) return null;
  if (typeof data === "object" && !Array.isArray(data)) return data;
  if (typeof data === "string") {
    try {
      const o = JSON.parse(data);
      return o && typeof o === "object" && !Array.isArray(o) ? o : null;
    } catch {
      return null;
    }
  }
  return null;
}

async function fetchLatestCampaignRowByPartitionKey(pool, partitionKey) {
  const key = String(partitionKey ?? "").trim();
  if (!key) return null;
  const result = await pool
    .request()
    .input("key", sql.VarChar(255), key)
    .query(
      `SELECT TOP (1) user_id, created_at, data
       FROM campaign_data
       WHERE user_id = @key
       ORDER BY created_at DESC, id DESC`
    );
  return result.recordset?.[0] ?? null;
}

/**
 * Datos legacy guardados como `campaign_data.user_id = username`; se busca cualquier usuario
 * cuyo `profile_json` declare el mismo `team_*` y se devuelve su fila más reciente.
 */
async function fetchLatestCampaignRowLegacySameTeam(pool, canonicalTeamId) {
  const team = String(canonicalTeamId ?? "").trim();
  if (!team || !CAMPATRACK_TEAM_ID_SET.has(team)) return null;
  try {
    const result = await pool.request().input("team", sql.VarChar(128), team).query(`
      SELECT TOP (1) cd.user_id, cd.created_at, cd.data
      FROM campaign_data AS cd
      INNER JOIN dbo.users AS u ON u.username = cd.user_id
      WHERE u.profile_json IS NOT NULL
        AND (
          EXISTS (
            SELECT 1
            FROM OPENJSON(u.profile_json, '$.teams') AS j
            WHERE LTRIM(RTRIM(ISNULL(CONVERT(NVARCHAR(256), j.value), N''))) = @team
          )
          OR LTRIM(RTRIM(ISNULL(JSON_VALUE(u.profile_json, '$.teamId'), N''))) = @team
        )
      ORDER BY cd.created_at DESC, cd.id DESC
    `);
    return result.recordset?.[0] ?? null;
  } catch (e) {
    console.warn(
      "[GET /api/data] Fallback legado por equipo (OPENJSON/JSON_VALUE):",
      e?.message || e
    );
    return null;
  }
}

/** `created_at` más reciente gana (varios usuarios → misma campaña por equipo). */
function campaignRowTimeMs(row) {
  if (!row) return -1;
  const d = row.created_at ?? row.CREATED_AT;
  if (!d && d !== 0) return -1;
  const ms = d instanceof Date ? d.getTime() : new Date(d).getTime();
  return Number.isFinite(ms) ? ms : -1;
}

function newerCampaignRow(a, b) {
  const ta = campaignRowTimeMs(a);
  const tb = campaignRowTimeMs(b);
  return tb > ta ? b || a : a || b;
}

/**
 * Para un `team_*`, la verdad observable es la fila **más nueva** ya sea guardada en clave equipo
 * o en username legado: así los cambios de ridigoal/ricardo sirven igual a wiener.
 */
async function fetchLatestCampaignRowForCanonicalTeam(pool, canonicalTeamId) {
  const team = String(canonicalTeamId ?? "").trim();
  if (!team || !CAMPATRACK_TEAM_ID_SET.has(team)) return null;
  const direct = await fetchLatestCampaignRowByPartitionKey(pool, team);
  const legacy = await fetchLatestCampaignRowLegacySameTeam(pool, team);
  return newerCampaignRow(direct, legacy);
}

/**
 * Convierte `user_id` del body/query (username o `team_*`) en la fila física única por equipo cuando
 * existe `profile_json` con equipo canónico (todos los miembros comparten escrituras).
 */
async function resolveCampaignStorageKey(pool, requestedKey) {
  const raw = String(requestedKey ?? "").trim();
  if (!raw) return raw;
  if (CAMPATRACK_TEAM_ID_SET.has(raw)) return raw;
  try {
    const result = await pool
      .request()
      .input("login", sql.VarChar(255), raw)
      .query(
        `SELECT TOP (1) profile_json FROM dbo.users WHERE username = @login`
      );
    let cell = result.recordset?.[0]?.profile_json;
    if (cell == null || cell === "") return raw;
    if (Buffer.isBuffer(cell)) cell = cell.toString("utf8");
    const profile =
      typeof cell === "string"
        ? JSON.parse(cell)
        : cell && typeof cell === "object"
          ? cell
          : JSON.parse(String(cell));
    const teams = normalizeTeamsFromStoredProfile(profile);
    if (!teams.length) return raw;
    if (teams.length === 1) return teams[0];
    /** Varios equipos canónicos: respeta teamId singular del perfil si cuadra. */
    let pick = "";
    const tid =
      profile && typeof profile.teamId === "string"
        ? profile.teamId.trim()
        : "";
    if (tid && teams.includes(tid)) pick = tid;
    if (!pick) pick = teams[0];
    return CAMPATRACK_TEAM_ID_SET.has(pick) ? pick : raw;
  } catch (e) {
    console.warn(
      "[POST campaign] resolveCampaignStorageKey:",
      e?.message || e
    );
    return raw;
  }
}

/** Headers HTTP para GET /api/data: evita 304 y respuestas servidas desde caché (proxy/navegador). */
function setCampaignGetApiDataNoCacheHeaders(res) {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0",
    "Surrogate-Control": "no-store",
  });
}

function campaignGetApiDataNoCacheMiddleware(_req, res, next) {
  setCampaignGetApiDataNoCacheHeaders(res);
  next();
}

function sendCampaignJsonFromRow(res, row) {
  if (!row) {
    return res.json({ data: null });
  }
  let raw =
    row.data !== undefined && row.data !== null
      ? row.data
      : row.DATA !== undefined && row.DATA !== null
        ? row.DATA
        : null;

  if (raw === null || raw === "") {
    return res.json({ data: null });
  }

  if (Buffer.isBuffer(raw)) {
    raw = raw.toString("utf8");
  }

  /** Acepta objeto ya parseado por el driver o string JSON; desenrolla doble serialización. */
  let data = raw;
  if (typeof data === "string") {
    for (let i = 0; i < 4 && typeof data === "string"; i++) {
      const s = data.trim();
      if (!s) {
        data = null;
        break;
      }
      try {
        data = JSON.parse(s);
      } catch (_parseErr) {
        return res.status(500).json({ error: "El campo data almacenado no es JSON válido" });
      }
    }
  }

  if (data == null || typeof data !== "object" || Array.isArray(data)) {
    return res.status(500).json({ error: "Formato de data inesperado" });
  }

  if (process.env.CAMPATRACK_DEBUG_API === "1") {
    console.log("DATA DEVUELTA (trim):", typeof data === "object" ? Object.keys(data) : "");
  }
  return res.json({ data });
}

/**
 * Persiste usuarios CampaTrack en SQL `users` para que `/api/login` pueda validarlos.
 * El cliente guarda `clave` ya hasheada (hex SHA-256); la columna `password` reproduce ese valor.
 */
/** JSON que devuelve /api/login y repone el perfil sin depender del bundle GET por user_id */
function campatrackUserProfileJsonPayload(rec) {
  const modulosList = [];
  const modulosRaw = rec?.modulos;
  if (Array.isArray(modulosRaw)) {
    for (const id of modulosRaw) {
      const k = String(id || "").trim();
      if (k) modulosList.push(k);
    }
  } else if (modulosRaw && typeof modulosRaw === "object") {
    for (const [k, v] of Object.entries(modulosRaw)) {
      if (v === true) modulosList.push(String(k));
    }
  }
  const p = rec?.permissions;
  let permissionsSlice;
  if (p && typeof p === "object" && !Array.isArray(p)) {
    permissionsSlice = {
      canExport: p.canExport === true,
      canImport: p.canImport === true,
      canReset: p.canReset === true,
    };
  }
  const teamsNorm = normalizeTeamsFromStoredProfile(rec);
  const o = {
    nombre: String(rec?.nombre || "").trim(),
    apellido: String(rec?.apellido || "").trim(),
    cargo: String(rec?.cargo || "").trim(),
    foto: typeof rec?.foto === "string" ? rec.foto.trim() : "",
    teams: teamsNorm,
    modulos: modulosList,
    permissions: permissionsSlice,
  };
  return JSON.stringify(o);
}

async function syncCampatrackUsersTableFromBundle(pool, bundle) {
  if (!bundle || !Array.isArray(bundle.campatrack_users_db) || bundle.campatrack_users_db.length === 0) {
    return;
  }
  const list = bundle.campatrack_users_db;

  const normalizeRole = (rol) => {
    const k = String(rol || "usuario").trim().toLowerCase();
    const allowed = new Set(["admin", "planner", "usuario", "viewer"]);
    return allowed.has(k) ? k : "usuario";
  };

  for (const u of list) {
    const uname = String(u.usuario ?? "").trim();
    if (!uname) continue;
    const estado = String(u.estado || "activo").toLowerCase();
    if (estado === "inactivo") {
      await pool
        .request()
        .input("username", sql.NVarChar(255), uname)
        .query(`DELETE FROM users WHERE username = @username`);
      continue;
    }
    const passwordStored = typeof u.clave === "string" ? u.clave.trim() : "";
    if (!passwordStored) continue;
    const teamsNorm = normalizeTeamsFromStoredProfile(u);
    if (!teamsNorm.length) {
      console.warn(
        "[syncCampatrackUsersTableFromBundle] Se omite usuario sin equipos válidos:",
        uname,
      );
      continue;
    }

    const role = normalizeRole(u.rol);
    const profileJson = campatrackUserProfileJsonPayload(u);
    const exists = await pool
      .request()
      .input("username", sql.NVarChar(255), uname)
      .query(`SELECT 1 AS x FROM users WHERE username = @username`);
    const hasRow = !!(exists.recordset && exists.recordset.length);
    if (hasRow) {
      await pool
        .request()
        .input("username", sql.NVarChar(255), uname)
        .input("password", sql.NVarChar(512), passwordStored)
        .input("role", sql.NVarChar(64), role)
        .input("profile_json", sql.NVarChar(sql.MAX), profileJson)
        .query(
          `UPDATE users SET password = @password, role = @role, profile_json = @profile_json WHERE username = @username`
        );
    } else {
      await pool
        .request()
        .input("username", sql.NVarChar(255), uname)
        .input("password", sql.NVarChar(512), passwordStored)
        .input("role", sql.NVarChar(64), role)
        .input("profile_json", sql.NVarChar(sql.MAX), profileJson)
        .query(
          `INSERT INTO users (username, password, role, profile_json) VALUES (@username, @password, @role, @profile_json)`
        );
    }
  }
}

const app = express();
app.disable("etag");
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "25mb" }));

app.post("/api/login", async (req, res) => {
  try {
    const username = req.body?.username;
    const password = req.body?.password;
    const teamIdRequested =
      req.body?.teamId != null ? String(req.body.teamId).trim() : "";
    if (
      username === undefined ||
      password === undefined ||
      username === "" ||
      password === ""
    ) {
      return res.status(400).json({ success: false, message: "Faltan credenciales" });
    }
    const usernameIn = String(username).trim();
    const plainPass = String(password);
    const pool = await getPool();
    const result = await pool
      .request()
      .input("username", sql.NVarChar(255), usernameIn)
      .query(
        `SELECT TOP (1) username, role, password, profile_json FROM users WHERE username = @username`
      );
    if (!result.recordset?.length) {
      return res.status(401).json({ success: false });
    }
    const row = result.recordset[0];
    const stored = row.password != null ? String(row.password) : "";
    const hashedAttempt = hashCampatrackPassword(usernameIn, plainPass);
    const ok =
      stored === plainPass ||
      stored.toLowerCase() === hashedAttempt.toLowerCase();
    if (!ok) {
      return res.status(401).json({ success: false });
    }
    let profile = {};
    const pj = row.profile_json != null ? String(row.profile_json).trim() : "";
    if (pj) {
      try {
        const parsed = JSON.parse(pj);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) profile = parsed;
      } catch {
        profile = {};
      }
    }
    const userTeams = normalizeTeamsFromStoredProfile(profile);
    if (!userTeams.length) {
      return res.status(403).json({
        success: false,
        message:
          "Este usuario no tiene equipos asignados. Contacta al administrador.",
      });
    }
    let teamIdEffective = teamIdRequested;
    if (!teamIdEffective) {
      teamIdEffective = userTeams[0];
    }
    if (!CAMPATRACK_TEAM_ID_SET.has(teamIdEffective)) {
      return res.status(400).json({ success: false, message: "Equipo no válido" });
    }
    if (!userTeams.includes(teamIdEffective)) {
      return res.status(403).json({
        success: false,
        message: "No tienes acceso a este equipo",
      });
    }

    const userPayload = {
      username: String(row.username ?? "").trim(),
      role: String(row.role ?? "").trim(),
      teamId: teamIdEffective,
      teams: userTeams,
    };
    for (const k of ["nombre", "apellido", "cargo", "foto"]) {
      const v = profile[k];
      if (typeof v === "string" && v.trim() !== "") userPayload[k] = v.trim();
    }
    const modArr = profile.modulos;
    if (Array.isArray(modArr) && modArr.length) {
      userPayload.modulos = modArr.map((x) => String(x || "").trim()).filter(Boolean);
    }
    const permsIn = profile.permissions;
    if (permsIn && typeof permsIn === "object" && !Array.isArray(permsIn)) {
      userPayload.permissions = {
        canExport: permsIn.canExport === true,
        canImport: permsIn.canImport === true,
        canReset: permsIn.canReset === true,
      };
    }
    res.json({
      success: true,
      user: userPayload,
    });
  } catch (err) {
    console.error("POST /api/login", err);
    res.status(500).json({ success: false, message: "Error del servidor" });
  }
});

/**
 * Guarda el bundle de campaña en SQL Server (misma conexión que login y GET /api/data).
 * Cuerpo esperado: { user_id, data } — `user_id` es la **clave de partición** (preferir `team_*`);
 * mismo valor que GET `team_id`. Compat: sigue admitiendo username legado.
 */
async function handlePostCampaignData(req, res) {
  try {
    const user_id =
      typeof req.body?.user_id === "string"
        ? req.body.user_id.trim()
        : String(req.body?.user_id ?? "").trim();
    const data = req.body?.data;

    if (!user_id || data === undefined || data === null) {
      return res.status(400).json({ error: "user_id y data son requeridos" });
    }

    const replace =
      req.query?.replace === "1" ||
      req.query?.replace === "true" ||
      req.body?.replace_user_campaign_data === true;

    const pool = await getPool();
    const storageKey = await resolveCampaignStorageKey(pool, user_id);

    if (replace) {
      await pool
        .request()
        .input("user_id", sql.VarChar(255), storageKey)
        .query(`DELETE FROM campaign_data WHERE user_id = @user_id`);
    }

    const dataPayload = typeof data === "string" ? data : JSON.stringify(data);

    await pool
      .request()
      .input("user_id", sql.VarChar(255), storageKey)
      .input("data", sql.NVarChar(sql.MAX), dataPayload)
      .query(
        `INSERT INTO campaign_data (user_id, data, created_at)
         VALUES (@user_id, @data, GETDATE())`
      );

    const bundleObj = parseBundleLikeObject(data);
    try {
      const keys = bundleObj && typeof bundleObj === "object" ? Object.keys(bundleObj) : [];
      const nPlan =
        bundleObj?.planning_data?.records != null && Array.isArray(bundleObj.planning_data.records)
          ? bundleObj.planning_data.records.length
          : Array.isArray(bundleObj?.planning)
            ? bundleObj.planning.length
            : "n/a";
      console.log("[CampaTrack API] POST guardado OK", {
        partition: storageKey,
        topKeyCount: keys.length,
        planningRecords: nPlan
      });
    } catch (_) {
      /* ignore */
    }
    if (bundleObj) {
      try {
        await syncCampatrackUsersTableFromBundle(pool, bundleObj);
      } catch (syncErr) {
        console.warn(
          "No se sincronizó tabla users desde campatrack_users_db:",
          syncErr?.message || syncErr
        );
      }
    }

    res.json({ ok: true });
  } catch (error) {
    console.error("Error guardando data:", error);
    res.status(500).json({ error: "Error guardando data" });
  }
}

app
  .route("/api/data")
  .get(campaignGetApiDataNoCacheMiddleware, async (req, res) => {
    try {
      const team_id =
        typeof req.query.team_id === "string"
          ? req.query.team_id.trim()
          : String(req.query.team_id ?? "").trim();
      const user_id =
        typeof req.query.user_id === "string"
          ? req.query.user_id.trim()
          : String(req.query.user_id ?? "").trim();

      const pool = await getPool();
      let row = null;

      if (team_id) {
        if (CAMPATRACK_TEAM_ID_SET.has(team_id)) {
          row = await fetchLatestCampaignRowForCanonicalTeam(pool, team_id);
        } else {
          row = await fetchLatestCampaignRowByPartitionKey(pool, team_id);
        }
      } else if (user_id) {
        const sk = await resolveCampaignStorageKey(pool, user_id);
        if (CAMPATRACK_TEAM_ID_SET.has(sk)) {
          row = await fetchLatestCampaignRowForCanonicalTeam(pool, sk);
        } else {
          row = await fetchLatestCampaignRowByPartitionKey(pool, user_id);
        }
      } else {
        return res
          .status(400)
          .json({ error: "Query team_id o user_id requerido" });
      }

      return sendCampaignJsonFromRow(res, row);
    } catch (err) {
      console.error("GET /api/data", err);
      res.status(500).json({ success: false, message: "Error del servidor" });
    }
  })
  .post(handlePostCampaignData);

/**
 * Desenrolla un backup descargado con GET /api/data (`{ data: bundle }`) al objeto `bundle`
 * que se persiste en columna (mismo formato que POST /api/data).
 */
function normalizeImportBodyForDb(data) {
  if (data == null || typeof data !== "object" || Array.isArray(data)) return data;
  if (!Object.prototype.hasOwnProperty.call(data, "data")) return data;
  const inner = data.data;
  if (inner == null || typeof inner !== "object" || Array.isArray(inner)) return data;
  const hints = [
    "planning_data",
    "data_general",
    "cc_data",
    "programs",
    "relaciones",
    "bitacora_data",
    "data_ads_report",
    "data_anuncios",
    "catalogos_sistema"
  ];
  const innerLooksBundle = hints.some((k) => Object.prototype.hasOwnProperty.call(inner, k));
  const topLooksBundle = hints.some((k) => Object.prototype.hasOwnProperty.call(data, k));
  if (innerLooksBundle && !topLooksBundle) return inner;
  return data;
}

/** Reemplaza por completo la fila de campaña del usuario (sin transformar el bundle salvo unwrap de export). */
app.post("/api/import-data", async (req, res) => {
  try {
    const user_id =
      typeof req.body?.user_id === "string"
        ? req.body.user_id.trim()
        : String(req.body?.user_id ?? "").trim();
    let data = req.body?.data;

    if (!user_id || data === undefined || data === null) {
      return res.status(400).json({ ok: false, error: "user_id y data son requeridos" });
    }

    const toStore = normalizeImportBodyForDb(data);
    if (toStore == null || typeof toStore !== "object" || Array.isArray(toStore)) {
      return res.status(400).json({ ok: false, error: "data debe ser un objeto JSON" });
    }

    const pool = await getPool();
    const storageKey = await resolveCampaignStorageKey(pool, user_id);
    const dataPayload = typeof toStore === "string" ? toStore : JSON.stringify(toStore);

    await pool
      .request()
      .input("user_id", sql.VarChar(255), storageKey)
      .query(`DELETE FROM campaign_data WHERE user_id = @user_id`);

    await pool
      .request()
      .input("user_id", sql.VarChar(255), storageKey)
      .input("data", sql.NVarChar(sql.MAX), dataPayload)
      .query(
        `INSERT INTO campaign_data (user_id, data, created_at)
         VALUES (@user_id, @data, GETDATE())`
      );

    const bundleObj = parseBundleLikeObject(toStore);
    if (bundleObj) {
      try {
        await syncCampatrackUsersTableFromBundle(pool, bundleObj);
      } catch (syncErr) {
        console.warn(
          "No se sincronizó tabla users tras import:",
          syncErr?.message || syncErr
        );
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/import-data", err);
    res.status(500).json({ ok: false, error: "Error importando data" });
  }
});

const server = app.listen(PORT, () => {
  console.log(`CampaTrack API escuchando en http://localhost:${PORT}`);
  console.log("Rutas: POST /api/login | GET+POST /api/data | POST /api/import-data");
  void getPool().catch((e) => {
    console.error("No se pudo conectar a SQL Server al arranque:", e?.message || e);
  });
});

server.on("error", (err) => {
  console.error(err);
  process.exit(1);
});
