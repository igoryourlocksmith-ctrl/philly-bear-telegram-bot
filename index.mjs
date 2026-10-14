import express from "express";
import TelegramBot from "node-telegram-bot-api";
import pg from "pg";

const { Pool } = pg;

const BUILD_ID = "2026-10-13-telegram-v1-multilocksmith-3min-notesbutton";
const PORT = Number(process.env.PORT || 3000);

const TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
const ADMIN_TELEGRAM_ID = String(process.env.ADMIN_TELEGRAM_ID || "").trim();
const INTERNAL_API_KEY = String(process.env.INTERNAL_API_KEY || "").trim();
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
const JOB_ACCEPT_TIMEOUT_SECONDS = Math.max(
  60,
  Number(process.env.JOB_ACCEPT_TIMEOUT_SECONDS || 180)
);

if (!TELEGRAM_BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const app = express();
app.use(express.json({ limit: "1mb" }));

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes("railway.internal")
        ? false
        : { rejectUnauthorized: false }
    })
  : null;

const reportSessions = new Map();

function nowIso() {
  return new Date().toISOString();
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function money(value) {
  const n = Number(value || 0);
  return `$${n.toFixed(2)}`;
}

function parseAmount(text) {
  const cleaned = String(text || "")
    .replaceAll("$", "")
    .replaceAll(",", "")
    .trim();

  const value = Number(cleaned);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function cleanZip(value = "") {
  const match = String(value).match(/\b(\d{5})\b/);
  return match ? match[1] : "";
}

function isAdmin(userId) {
  return Boolean(ADMIN_TELEGRAM_ID) && String(userId) === ADMIN_TELEGRAM_ID;
}

function requireDb(res) {
  if (pool) return false;
  res.status(503).json({
    ok: false,
    error: "DATABASE_URL is required for multi-locksmith routing"
  });
  return true;
}

async function initDb() {
  if (!pool) {
    console.warn(
      "DATABASE_URL is not configured. Bot can start, but multi-locksmith routing is disabled until PostgreSQL is connected."
    );
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS locksmiths (
      id BIGSERIAL PRIMARY KEY,
      telegram_user_id BIGINT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      phone TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      last_assigned_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS locksmith_zip_coverage (
      id BIGSERIAL PRIMARY KEY,
      locksmith_id BIGINT NOT NULL REFERENCES locksmiths(id) ON DELETE CASCADE,
      zip_code VARCHAR(5) NOT NULL,
      priority INTEGER NOT NULL DEFAULT 100,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      UNIQUE(locksmith_id, zip_code)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS jobs (
      id BIGSERIAL PRIMARY KEY,
      job_code TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'NEW',

      customer_name TEXT,
      customer_phone TEXT,
      language TEXT,
      service TEXT,
      vehicle TEXT,
      problem TEXT,
      zip_code VARCHAR(5),
      address TEXT,
      location_detail TEXT,

      estimate_min NUMERIC(10,2),
      estimate_max NUMERIC(10,2),
      requested_time TEXT,
      notes TEXT,

      assigned_locksmith_id BIGINT REFERENCES locksmiths(id),
      current_assignment_id BIGINT,

      final_amount NUMERIC(10,2),
      payment_method TEXT,
      tip NUMERIC(10,2) NOT NULL DEFAULT 0,
      completion_notes TEXT,

      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      accepted_at TIMESTAMPTZ,
      en_route_at TIMESTAMPTZ,
      arrived_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS job_assignments (
      id BIGSERIAL PRIMARY KEY,
      job_id BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      locksmith_id BIGINT NOT NULL REFERENCES locksmiths(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'PENDING',
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      responded_at TIMESTAMPTZ,
      telegram_chat_id BIGINT,
      telegram_message_id BIGINT,
      attempt_number INTEGER NOT NULL,
      UNIQUE(job_id, locksmith_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS materials (
      id BIGSERIAL PRIMARY KEY,
      job_id BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      cost NUMERIC(10,2) NOT NULL DEFAULT 0
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS job_events (
      id BIGSERIAL PRIMARY KEY,
      job_id BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      locksmith_id BIGINT REFERENCES locksmiths(id),
      details JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_zip_coverage_zip
    ON locksmith_zip_coverage(zip_code, active, priority);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_assignments_pending
    ON job_assignments(status, expires_at);
  `);

  console.log("PostgreSQL schema ready.");
}

async function logEvent(jobId, eventType, locksmithId = null, details = {}) {
  if (!pool) return;

  await pool.query(
    `INSERT INTO job_events(job_id, event_type, locksmith_id, details)
     VALUES ($1,$2,$3,$4::jsonb)`,
    [jobId, eventType, locksmithId, JSON.stringify(details)]
  );
}

async function getLocksmithByTelegramId(telegramUserId) {
  if (!pool) return null;

  const result = await pool.query(
    `SELECT * FROM locksmiths WHERE telegram_user_id=$1`,
    [telegramUserId]
  );

  return result.rows[0] || null;
}

async function getLocksmithById(id) {
  if (!pool) return null;

  const result = await pool.query(
    `SELECT * FROM locksmiths WHERE id=$1`,
    [id]
  );

  return result.rows[0] || null;
}

async function upsertLocksmith(telegramUserId, displayName) {
  const result = await pool.query(
    `
      INSERT INTO locksmiths(telegram_user_id, display_name)
      VALUES ($1,$2)
      ON CONFLICT(telegram_user_id)
      DO UPDATE SET display_name=EXCLUDED.display_name
      RETURNING *
    `,
    [telegramUserId, displayName]
  );

  return result.rows[0];
}

async function setLocksmithActive(telegramUserId, active) {
  const result = await pool.query(
    `UPDATE locksmiths
     SET active=$2
     WHERE telegram_user_id=$1
     RETURNING *`,
    [telegramUserId, active]
  );

  return result.rows[0] || null;
}

async function addZipCoverage(telegramUserId, zipCode, priority = 100) {
  const locksmith = await getLocksmithByTelegramId(telegramUserId);
  if (!locksmith) throw new Error("Locksmith not found");

  await pool.query(
    `
      INSERT INTO locksmith_zip_coverage(locksmith_id, zip_code, priority, active)
      VALUES ($1,$2,$3,TRUE)
      ON CONFLICT(locksmith_id, zip_code)
      DO UPDATE SET priority=EXCLUDED.priority, active=TRUE
    `,
    [locksmith.id, zipCode, priority]
  );

  return locksmith;
}

async function removeZipCoverage(telegramUserId, zipCode) {
  const locksmith = await getLocksmithByTelegramId(telegramUserId);
  if (!locksmith) throw new Error("Locksmith not found");

  await pool.query(
    `DELETE FROM locksmith_zip_coverage
     WHERE locksmith_id=$1 AND zip_code=$2`,
    [locksmith.id, zipCode]
  );
}

async function listCoverage(telegramUserId) {
  const locksmith = await getLocksmithByTelegramId(telegramUserId);
  if (!locksmith) return { locksmith: null, coverage: [] };

  const result = await pool.query(
    `
      SELECT zip_code, priority, active
      FROM locksmith_zip_coverage
      WHERE locksmith_id=$1
      ORDER BY priority ASC, zip_code ASC
    `,
    [locksmith.id]
  );

  return { locksmith, coverage: result.rows };
}

async function listLocksmiths() {
  const result = await pool.query(`
    SELECT
      l.id,
      l.telegram_user_id,
      l.display_name,
      l.active,
      COALESCE(
        string_agg(
          z.zip_code || ':' || z.priority::text,
          ', ' ORDER BY z.priority, z.zip_code
        ) FILTER (WHERE z.active),
        ''
      ) AS coverage
    FROM locksmiths l
    LEFT JOIN locksmith_zip_coverage z ON z.locksmith_id=l.id
    GROUP BY l.id
    ORDER BY l.display_name
  `);

  return result.rows;
}

async function createJob(input = {}) {
  const zipCode = cleanZip(input.zip_code || input.zip || "");
  if (!zipCode) {
    throw new Error("Valid 5-digit ZIP code is required");
  }

  const jobCode =
    input.job_code ||
    `PB-${String(Date.now()).slice(-6)}`;

  const result = await pool.query(
    `
      INSERT INTO jobs(
        job_code, status,
        customer_name, customer_phone, language, service,
        vehicle, problem, zip_code, address, location_detail,
        estimate_min, estimate_max, requested_time, notes
      )
      VALUES(
        $1,'NEW',
        $2,$3,$4,$5,
        $6,$7,$8,$9,$10,
        $11,$12,$13,$14
      )
      RETURNING *
    `,
    [
      jobCode,
      input.customer_name || "",
      input.customer_phone || "",
      input.language || "",
      input.service || "",
      input.vehicle || "",
      input.problem || "",
      zipCode,
      input.address || "",
      input.location_detail || "",
      input.estimate_min ?? null,
      input.estimate_max ?? null,
      input.requested_time || "ASAP",
      input.notes || ""
    ]
  );

  const job = result.rows[0];
  await logEvent(job.id, "JOB_CREATED", null, input);
  return job;
}

async function getJob(jobId) {
  const result = await pool.query(
    `SELECT * FROM jobs WHERE id=$1`,
    [jobId]
  );

  return result.rows[0] || null;
}

async function getAssignment(assignmentId) {
  const result = await pool.query(
    `
      SELECT
        a.*,
        l.telegram_user_id,
        l.display_name,
        j.job_code,
        j.status AS job_status,
        j.assigned_locksmith_id,
        j.current_assignment_id
      FROM job_assignments a
      JOIN locksmiths l ON l.id=a.locksmith_id
      JOIN jobs j ON j.id=a.job_id
      WHERE a.id=$1
    `,
    [assignmentId]
  );

  return result.rows[0] || null;
}

async function getMaterials(jobId) {
  const result = await pool.query(
    `SELECT id, name, cost
     FROM materials
     WHERE job_id=$1
     ORDER BY id`,
    [jobId]
  );

  return result.rows;
}

function estimateText(job) {
  if (job.estimate_min !== null && job.estimate_max !== null) {
    return `${money(job.estimate_min)}–${money(job.estimate_max)}`;
  }

  if (job.estimate_min !== null) {
    return `From ${money(job.estimate_min)}`;
  }

  return "Not quoted";
}

function jobCard(job) {
  const lines = [
    `🔐 <b>NEW JOB ${escapeHtml(job.job_code)}</b>`,
    "",
    job.customer_name
      ? `👤 <b>Customer:</b> ${escapeHtml(job.customer_name)}`
      : "",
    job.customer_phone
      ? `📞 <b>Phone:</b> ${escapeHtml(job.customer_phone)}`
      : "",
    job.language
      ? `🗣 <b>Language:</b> ${escapeHtml(job.language)}`
      : "",
    job.service
      ? `🛠 <b>Service:</b> ${escapeHtml(job.service)}`
      : "",
    job.vehicle
      ? `🚗 <b>Vehicle:</b> ${escapeHtml(job.vehicle)}`
      : "",
    job.problem
      ? `❗️ <b>Problem:</b> ${escapeHtml(job.problem)}`
      : "",
    `📮 <b>ZIP:</b> ${escapeHtml(job.zip_code || "")}`,
    job.address
      ? `📍 <b>Address:</b> ${escapeHtml(job.address)}`
      : "",
    job.location_detail
      ? `🅿️ <b>Location:</b> ${escapeHtml(job.location_detail)}`
      : "",
    `💵 <b>Estimate:</b> ${escapeHtml(estimateText(job))}`,
    `🕐 <b>Requested:</b> ${escapeHtml(job.requested_time || "ASAP")}`,
    job.notes
      ? `📝 <b>Notes:</b> ${escapeHtml(job.notes)}`
      : ""
  ].filter(Boolean);

  return lines.join("\n");
}

function assignmentKeyboard(assignmentId, address = "") {
  const rows = [
    [
      {
        text: "✅ ACCEPT",
        callback_data: `as:${assignmentId}:accept`
      },
      {
        text: "❌ DECLINE",
        callback_data: `as:${assignmentId}:decline`
      }
    ]
  ];

  if (address) {
    rows.push([
      {
        text: "📍 NAVIGATE",
        url:
          "https://www.google.com/maps/search/?api=1&query=" +
          encodeURIComponent(address)
      }
    ]);
  }

  return { inline_keyboard: rows };
}

function acceptedKeyboard(assignmentId, address = "") {
  const rows = [
    [
      {
        text: "🚐 EN ROUTE",
        callback_data: `as:${assignmentId}:enroute`
      },
      {
        text: "🚫 CANCEL",
        callback_data: `as:${assignmentId}:cancel`
      }
    ]
  ];

  if (address) {
    rows.push([
      {
        text: "📍 NAVIGATE",
        url:
          "https://www.google.com/maps/search/?api=1&query=" +
          encodeURIComponent(address)
      }
    ]);
  }

  return { inline_keyboard: rows };
}

function enRouteKeyboard(assignmentId) {
  return {
    inline_keyboard: [
      [
        {
          text: "📍 ARRIVED",
          callback_data: `as:${assignmentId}:arrived`
        },
        {
          text: "🚫 CANCEL",
          callback_data: `as:${assignmentId}:cancel`
        }
      ]
    ]
  };
}

function arrivedKeyboard(assignmentId) {
  return {
    inline_keyboard: [
      [
        {
          text: "✅ COMPLETE JOB",
          callback_data: `as:${assignmentId}:complete`
        },
        {
          text: "🚫 CANCEL",
          callback_data: `as:${assignmentId}:cancel`
        }
      ]
    ]
  };
}

function materialsKeyboard(assignmentId) {
  return {
    inline_keyboard: [
      [
        {
          text: "➕ ADD MATERIAL",
          callback_data: `rp:${assignmentId}:material`
        }
      ],
      [
        {
          text: "➡️ DONE WITH MATERIALS",
          callback_data: `rp:${assignmentId}:materials_done`
        }
      ]
    ]
  };
}

function paymentKeyboard(assignmentId) {
  return {
    inline_keyboard: [
      [
        {
          text: "💵 Cash",
          callback_data: `rp:${assignmentId}:pay:Cash`
        },
        {
          text: "💳 Card",
          callback_data: `rp:${assignmentId}:pay:Card`
        }
      ],
      [
        {
          text: "🏦 Zelle",
          callback_data: `rp:${assignmentId}:pay:Zelle`
        },
        {
          text: "📱 Venmo",
          callback_data: `rp:${assignmentId}:pay:Venmo`
        }
      ],
      [
        {
          text: "Other",
          callback_data: `rp:${assignmentId}:pay:Other`
        }
      ]
    ]
  };
}

function completionNotesKeyboard(assignmentId) {
  return {
    inline_keyboard: [
      [
        {
          text: "⏭ NO NOTES",
          callback_data: `rp:${assignmentId}:skip_notes`
        }
      ]
    ]
  };
}

async function updateAssignmentMessage(
  assignment,
  text,
  replyMarkup = { inline_keyboard: [] }
) {
  if (!assignment.telegram_chat_id || !assignment.telegram_message_id) {
    return;
  }

  try {
    await bot.editMessageText(text, {
      chat_id: assignment.telegram_chat_id,
      message_id: assignment.telegram_message_id,
      parse_mode: "HTML",
      reply_markup: replyMarkup,
      disable_web_page_preview: true
    });
  } catch (err) {
    console.error("editMessageText:", err.message);
  }
}

async function markAssignment(
  assignmentId,
  status,
  responded = false
) {
  await pool.query(
    `
      UPDATE job_assignments
      SET
        status=$2,
        responded_at=CASE
          WHEN $3::boolean THEN NOW()
          ELSE responded_at
        END
      WHERE id=$1
    `,
    [assignmentId, status, responded]
  );
}

async function clearCurrentAssignment(jobId, assignmentId) {
  await pool.query(
    `
      UPDATE jobs
      SET assigned_locksmith_id=NULL,
          current_assignment_id=NULL
      WHERE id=$1
        AND current_assignment_id=$2
    `,
    [jobId, assignmentId]
  );
}

async function chooseNextLocksmith(jobId, zipCode) {
  const result = await pool.query(
    `
      SELECT
        l.*,
        z.priority
      FROM locksmiths l
      JOIN locksmith_zip_coverage z
        ON z.locksmith_id=l.id
      WHERE
        l.active=TRUE
        AND z.active=TRUE
        AND z.zip_code=$2
        AND NOT EXISTS (
          SELECT 1
          FROM job_assignments a
          WHERE a.job_id=$1
            AND a.locksmith_id=l.id
        )
      ORDER BY
        z.priority ASC,
        l.last_assigned_at ASC NULLS FIRST,
        l.id ASC
      LIMIT 1
    `,
    [jobId, zipCode]
  );

  return result.rows[0] || null;
}

async function routeJob(jobId) {
  const job = await getJob(jobId);
  if (!job) return { ok: false, reason: "job-not-found" };

  const locksmith = await chooseNextLocksmith(
    job.id,
    job.zip_code
  );

  if (!locksmith) {
    await pool.query(
      `UPDATE jobs SET status='UNASSIGNED' WHERE id=$1`,
      [job.id]
    );

    await logEvent(
      job.id,
      "NO_LOCKSMITH_AVAILABLE",
      null,
      { zip_code: job.zip_code }
    );

    if (ADMIN_TELEGRAM_ID) {
      await bot.sendMessage(
        ADMIN_TELEGRAM_ID,
        `⚠️ ${job.job_code}: no available locksmith covers ZIP ${job.zip_code}.`
      ).catch(() => {});
    }

    return {
      ok: false,
      reason: "no-locksmith"
    };
  }

  const attemptResult = await pool.query(
    `
      SELECT COUNT(*)::int AS attempts
      FROM job_assignments
      WHERE job_id=$1
    `,
    [job.id]
  );

  const attemptNumber =
    Number(attemptResult.rows[0]?.attempts || 0) + 1;

  const assignmentResult = await pool.query(
    `
      INSERT INTO job_assignments(
        job_id,
        locksmith_id,
        status,
        expires_at,
        attempt_number
      )
      VALUES(
        $1,
        $2,
        'PENDING',
        NOW() + ($3::text || ' seconds')::interval,
        $4
      )
      RETURNING *
    `,
    [
      job.id,
      locksmith.id,
      JOB_ACCEPT_TIMEOUT_SECONDS,
      attemptNumber
    ]
  );

  const assignment = assignmentResult.rows[0];

  await pool.query(
    `
      UPDATE jobs
      SET
        status='OFFERED',
        assigned_locksmith_id=$2,
        current_assignment_id=$3
      WHERE id=$1
    `,
    [job.id, locksmith.id, assignment.id]
  );

  await pool.query(
    `
      UPDATE locksmiths
      SET last_assigned_at=NOW()
      WHERE id=$1
    `,
    [locksmith.id]
  );

  let sent;

  try {
    sent = await bot.sendMessage(
      String(locksmith.telegram_user_id),
      jobCard(job),
      {
        parse_mode: "HTML",
        reply_markup: assignmentKeyboard(
          assignment.id,
          job.address
        ),
        disable_web_page_preview: true
      }
    );
  } catch (err) {
    console.error(
      "Could not send job to locksmith",
      locksmith.display_name,
      err.message
    );

    await markAssignment(
      assignment.id,
      "DELIVERY_FAILED",
      true
    );

    await clearCurrentAssignment(
      job.id,
      assignment.id
    );

    await logEvent(
      job.id,
      "ASSIGNMENT_DELIVERY_FAILED",
      locksmith.id,
      { error: err.message }
    );

    return routeJob(job.id);
  }

  await pool.query(
    `
      UPDATE job_assignments
      SET
        telegram_chat_id=$2,
        telegram_message_id=$3
      WHERE id=$1
    `,
    [
      assignment.id,
      sent.chat.id,
      sent.message_id
    ]
  );

  await logEvent(
    job.id,
    "JOB_OFFERED",
    locksmith.id,
    {
      assignment_id: assignment.id,
      attempt_number: attemptNumber,
      priority: locksmith.priority,
      expires_in_seconds: JOB_ACCEPT_TIMEOUT_SECONDS
    }
  );

  return {
    ok: true,
    locksmith,
    assignment
  };
}

async function expireAssignment(assignmentId) {
  const assignment = await getAssignment(assignmentId);

  if (!assignment) return;
  if (assignment.status !== "PENDING") return;

  const job = await getJob(assignment.job_id);

  await markAssignment(
    assignment.id,
    "TIMEOUT",
    true
  );

  await clearCurrentAssignment(
    assignment.job_id,
    assignment.id
  );

  await updateAssignmentMessage(
    assignment,
    `${jobCard(job)}\n\n⏱ <b>EXPIRED — reassigned to another locksmith.</b>`
  );

  await logEvent(
    assignment.job_id,
    "ASSIGNMENT_TIMEOUT",
    assignment.locksmith_id,
    { assignment_id: assignment.id }
  );

  await routeJob(assignment.job_id);
}

async function sweepExpiredAssignments() {
  if (!pool) return;

  try {
    const result = await pool.query(`
      SELECT id
      FROM job_assignments
      WHERE status='PENDING'
        AND expires_at <= NOW()
      ORDER BY expires_at
      LIMIT 25
    `);

    for (const row of result.rows) {
      await expireAssignment(row.id);
    }
  } catch (err) {
    console.error("Timeout sweep error:", err.message);
  }
}

async function verifyAssignmentOwner(
  assignmentId,
  telegramUserId
) {
  const assignment = await getAssignment(assignmentId);

  if (!assignment) {
    return {
      ok: false,
      assignment: null,
      reason: "Assignment not found."
    };
  }

  if (
    String(assignment.telegram_user_id) !==
    String(telegramUserId)
  ) {
    return {
      ok: false,
      assignment,
      reason: "This job is not assigned to you."
    };
  }

  if (
    Number(assignment.current_assignment_id) !==
    Number(assignment.id)
  ) {
    return {
      ok: false,
      assignment,
      reason: "This assignment is no longer active."
    };
  }

  return {
    ok: true,
    assignment
  };
}

async function setJobStatus(jobId, status) {
  const timeColumns = {
    ACCEPTED: "accepted_at",
    EN_ROUTE: "en_route_at",
    ARRIVED: "arrived_at",
    COMPLETED: "completed_at"
  };

  const column = timeColumns[status];

  if (column) {
    await pool.query(
      `
        UPDATE jobs
        SET status=$2, ${column}=NOW()
        WHERE id=$1
      `,
      [jobId, status]
    );
  } else {
    await pool.query(
      `UPDATE jobs SET status=$2 WHERE id=$1`,
      [jobId, status]
    );
  }
}

async function addMaterial(jobId, name, cost) {
  await pool.query(
    `
      INSERT INTO materials(job_id, name, cost)
      VALUES ($1,$2,$3)
    `,
    [jobId, name, cost]
  );
}

async function saveFinalAmount(jobId, amount) {
  await pool.query(
    `UPDATE jobs SET final_amount=$2 WHERE id=$1`,
    [jobId, amount]
  );
}

async function savePayment(jobId, method) {
  await pool.query(
    `UPDATE jobs SET payment_method=$2 WHERE id=$1`,
    [jobId, method]
  );
}

async function saveTip(jobId, tip) {
  await pool.query(
    `UPDATE jobs SET tip=$2 WHERE id=$1`,
    [jobId, tip]
  );
}

async function saveCompletionNotes(jobId, notes) {
  await pool.query(
    `UPDATE jobs SET completion_notes=$2 WHERE id=$1`,
    [jobId, notes]
  );
}

async function finalizeCompletedJob(userId, assignment, notes, chatId) {
  await saveCompletionNotes(
    assignment.job_id,
    notes
  );

  await setJobStatus(
    assignment.job_id,
    "COMPLETED"
  );

  await markAssignment(
    assignment.id,
    "COMPLETED",
    true
  );

  const job =
    await getJob(
      assignment.job_id
    );

  const materials =
    await getMaterials(
      assignment.job_id
    );

  const materialsTotal =
    materials.reduce(
      (sum, item) =>
        sum + Number(item.cost),
      0
    );

  const finalAmount =
    Number(
      job.final_amount || 0
    );

  const tip =
    Number(job.tip || 0);

  const totalCollected =
    finalAmount + tip;

  const grossBeforeLabor =
    finalAmount -
    materialsTotal;

  const materialLines =
    materials.length
      ? materials
          .map(
            (m) =>
              `• ${escapeHtml(m.name)} — ${money(m.cost)}`
          )
          .join("\n")
      : "• None";

  const summary = [
    `✅ <b>${escapeHtml(job.job_code)} — COMPLETED</b>`,
    "",
    `💵 <b>Final price:</b> ${money(finalAmount)}`,
    "<b>Materials:</b>",
    materialLines,
    `<b>Materials total:</b> ${money(materialsTotal)}`,
    `💳 <b>Payment:</b> ${escapeHtml(job.payment_method || "Not specified")}`,
    `💰 <b>Tip:</b> ${money(tip)}`,
    `<b>Total collected:</b> ${money(totalCollected)}`,
    `<b>Gross before labor/overhead:</b> ${money(grossBeforeLabor)}`,
    notes
      ? `📝 <b>Completion notes:</b> ${escapeHtml(notes)}`
      : ""
  ]
    .filter(Boolean)
    .join("\n");

  reportSessions.delete(userId);

  await updateAssignmentMessage(
    assignment,
    `${jobCard(job)}\n\n✅ <b>COMPLETED</b>`
  );

  await bot.sendMessage(
    chatId,
    summary,
    { parse_mode: "HTML" }
  );

  await logEvent(
    assignment.job_id,
    "JOB_COMPLETED",
    assignment.locksmith_id,
    {
      final_amount: finalAmount,
      materials_total:
        materialsTotal,
      payment_method:
        job.payment_method,
      tip
    }
  );
}

bot.onText(/^\/start$/, async (msg) => {
  const telegramUserId = String(msg.from.id);

  if (!pool) {
    await bot.sendMessage(
      msg.chat.id,
      [
        "Philly Bear Dispatcher is running, but PostgreSQL is not connected.",
        "",
        `Your Telegram User ID: ${telegramUserId}`
      ].join("\n")
    );
    return;
  }

  const locksmith =
    await getLocksmithByTelegramId(telegramUserId);

  if (locksmith) {
    await bot.sendMessage(
      msg.chat.id,
      [
        `🐻 Philly Bear Dispatcher`,
        `Welcome, ${locksmith.display_name}.`,
        "",
        "You will receive only jobs assigned specifically to you.",
        "",
        "/myjobs — your active jobs",
        "/mycoverage — your ZIP coverage",
        "/myid — your Telegram User ID"
      ].join("\n")
    );
    return;
  }

  if (isAdmin(telegramUserId)) {
    await bot.sendMessage(
      msg.chat.id,
      [
        "🐻 Philly Bear Dispatcher — Admin",
        "",
        `Your Telegram User ID: ${telegramUserId}`,
        "",
        "Admin commands:",
        "/addlocksmith TELEGRAM_ID Name",
        "/addzip TELEGRAM_ID ZIP PRIORITY",
        "/removezip TELEGRAM_ID ZIP",
        "/setactive TELEGRAM_ID on|off",
        "/locksmiths",
        "/testjob ZIP",
        "",
        "A locksmith must first open this bot and send /myid so you know their numeric Telegram ID."
      ].join("\n")
    );
    return;
  }

  await bot.sendMessage(
    msg.chat.id,
    [
      "Philly Bear Dispatcher.",
      "",
      "You are not registered as a locksmith.",
      `Your Telegram User ID: ${telegramUserId}`,
      "",
      "Send this User ID to the administrator."
    ].join("\n")
  );
});

bot.onText(/^\/myid$/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    `Your Telegram User ID: ${msg.from.id}`
  );
});

bot.onText(
  /^\/addlocksmith\s+(\d+)\s+(.+)$/i,
  async (msg, match) => {
    if (!pool || !isAdmin(msg.from.id)) return;

    const telegramUserId = match[1];
    const displayName = match[2].trim();

    const locksmith = await upsertLocksmith(
      telegramUserId,
      displayName
    );

    await bot.sendMessage(
      msg.chat.id,
      `✅ Locksmith added: ${locksmith.display_name} (${locksmith.telegram_user_id})`
    );
  }
);

bot.onText(
  /^\/addzip\s+(\d+)\s+(\d{5})(?:\s+(\d+))?$/i,
  async (msg, match) => {
    if (!pool || !isAdmin(msg.from.id)) return;

    const telegramUserId = match[1];
    const zipCode = match[2];
    const priority = Number(match[3] || 100);

    try {
      const locksmith = await addZipCoverage(
        telegramUserId,
        zipCode,
        priority
      );

      await bot.sendMessage(
        msg.chat.id,
        `✅ ${locksmith.display_name}: ZIP ${zipCode}, priority ${priority}`
      );
    } catch (err) {
      await bot.sendMessage(
        msg.chat.id,
        `Error: ${err.message}`
      );
    }
  }
);

bot.onText(
  /^\/removezip\s+(\d+)\s+(\d{5})$/i,
  async (msg, match) => {
    if (!pool || !isAdmin(msg.from.id)) return;

    try {
      await removeZipCoverage(
        match[1],
        match[2]
      );

      await bot.sendMessage(
        msg.chat.id,
        `Removed ZIP ${match[2]} from locksmith ${match[1]}.`
      );
    } catch (err) {
      await bot.sendMessage(
        msg.chat.id,
        `Error: ${err.message}`
      );
    }
  }
);

bot.onText(
  /^\/setactive\s+(\d+)\s+(on|off)$/i,
  async (msg, match) => {
    if (!pool || !isAdmin(msg.from.id)) return;

    const active =
      match[2].toLowerCase() === "on";

    const locksmith =
      await setLocksmithActive(
        match[1],
        active
      );

    if (!locksmith) {
      await bot.sendMessage(
        msg.chat.id,
        "Locksmith not found."
      );
      return;
    }

    await bot.sendMessage(
      msg.chat.id,
      `${locksmith.display_name}: ${active ? "ACTIVE" : "INACTIVE"}`
    );
  }
);

bot.onText(/^\/locksmiths$/i, async (msg) => {
  if (!pool || !isAdmin(msg.from.id)) return;

  const locksmiths = await listLocksmiths();

  if (!locksmiths.length) {
    await bot.sendMessage(
      msg.chat.id,
      "No locksmiths registered."
    );
    return;
  }

  const text = locksmiths
    .map((l) => {
      return [
        `${l.active ? "🟢" : "⚫️"} ${l.display_name}`,
        `ID: ${l.telegram_user_id}`,
        `ZIP: ${l.coverage || "none"}`
      ].join("\n");
    })
    .join("\n\n");

  await bot.sendMessage(
    msg.chat.id,
    text
  );
});

bot.onText(/^\/mycoverage$/i, async (msg) => {
  if (!pool) return;

  const result =
    await listCoverage(String(msg.from.id));

  if (!result.locksmith) {
    await bot.sendMessage(
      msg.chat.id,
      "You are not registered as a locksmith."
    );
    return;
  }

  const text = result.coverage.length
    ? result.coverage
        .map(
          (z) =>
            `${z.zip_code} — priority ${z.priority}`
        )
        .join("\n")
    : "No ZIP coverage assigned.";

  await bot.sendMessage(
    msg.chat.id,
    `Coverage for ${result.locksmith.display_name}:\n\n${text}`
  );
});

bot.onText(/^\/myjobs$/i, async (msg) => {
  if (!pool) return;

  const locksmith =
    await getLocksmithByTelegramId(
      String(msg.from.id)
    );

  if (!locksmith) {
    await bot.sendMessage(
      msg.chat.id,
      "You are not registered as a locksmith."
    );
    return;
  }

  const result = await pool.query(
    `
      SELECT j.*
      FROM jobs j
      WHERE
        j.assigned_locksmith_id=$1
        AND j.status NOT IN (
          'COMPLETED',
          'DECLINED',
          'CANCELLED',
          'UNASSIGNED'
        )
      ORDER BY j.received_at DESC
      LIMIT 10
    `,
    [locksmith.id]
  );

  if (!result.rows.length) {
    await bot.sendMessage(
      msg.chat.id,
      "You have no active assigned jobs."
    );
    return;
  }

  for (const job of result.rows) {
    await bot.sendMessage(
      msg.chat.id,
      jobCard(job),
      {
        parse_mode: "HTML",
        disable_web_page_preview: true
      }
    );
  }
});

bot.onText(
  /^\/testjob(?:\s+(\d{5}))?$/i,
  async (msg, match) => {
    if (!pool || !isAdmin(msg.from.id)) return;

    const zipCode = match[1] || "19147";

    const job = await createJob({
      customer_name: "Ivan Test",
      customer_phone: "+12155550147",
      language: "English",
      service: "Vehicle Lockout",
      vehicle: "2024 Kia Seltos",
      problem: "Key locked inside vehicle",
      zip_code: zipCode,
      address:
        "2040 S 13th St, Philadelphia, PA 19148",
      location_detail:
        "Vehicle parked on street",
      estimate_min: 120,
      estimate_max: 160,
      requested_time: "ASAP",
      notes:
        "Test order. Customer can see the key inside."
    });

    const routed = await routeJob(job.id);

    await bot.sendMessage(
      msg.chat.id,
      routed.ok
        ? `✅ ${job.job_code} routed to ${routed.locksmith.display_name}.`
        : `⚠️ ${job.job_code} created but no locksmith is available for ZIP ${zipCode}.`
    );
  }
);

bot.on("callback_query", async (query) => {
  await bot
    .answerCallbackQuery(query.id)
    .catch(() => {});

  if (!pool) return;

  const userId = String(query.from.id);
  const data = String(query.data || "");
  const parts = data.split(":");

  if (parts[0] === "as") {
    const assignmentId = parts[1];
    const action = parts[2];

    const verification =
      await verifyAssignmentOwner(
        assignmentId,
        userId
      );

    if (!verification.ok) {
      await bot.sendMessage(
        query.message.chat.id,
        verification.reason
      );
      return;
    }

    let assignment = verification.assignment;
    const job = await getJob(assignment.job_id);

    if (action === "accept") {
      if (assignment.status !== "PENDING") {
        await bot.sendMessage(
          query.message.chat.id,
          "This job offer is no longer pending."
        );
        return;
      }

      await markAssignment(
        assignment.id,
        "ACCEPTED",
        true
      );

      await setJobStatus(
        assignment.job_id,
        "ACCEPTED"
      );

      assignment =
        await getAssignment(
          assignment.id
        );

      await updateAssignmentMessage(
        assignment,
        `${jobCard(job)}\n\n✅ <b>ACCEPTED</b>`,
        acceptedKeyboard(
          assignment.id,
          job.address
        )
      );

      await logEvent(
        assignment.job_id,
        "JOB_ACCEPTED",
        assignment.locksmith_id,
        { assignment_id: assignment.id }
      );

      return;
    }

    if (action === "decline") {
      await markAssignment(
        assignment.id,
        "DECLINED",
        true
      );

      await clearCurrentAssignment(
        assignment.job_id,
        assignment.id
      );

      await updateAssignmentMessage(
        assignment,
        `${jobCard(job)}\n\n❌ <b>DECLINED — reassigned.</b>`
      );

      await logEvent(
        assignment.job_id,
        "JOB_DECLINED",
        assignment.locksmith_id,
        { assignment_id: assignment.id }
      );

      await routeJob(
        assignment.job_id
      );

      return;
    }

    if (action === "cancel") {
      await markAssignment(
        assignment.id,
        "CANCELLED",
        true
      );

      await setJobStatus(
        assignment.job_id,
        "CANCELLED"
      );

      await updateAssignmentMessage(
        assignment,
        `${jobCard(job)}\n\n🚫 <b>CANCELLED</b>`
      );

      await logEvent(
        assignment.job_id,
        "JOB_CANCELLED",
        assignment.locksmith_id,
        { assignment_id: assignment.id }
      );

      return;
    }

    if (assignment.status !== "ACCEPTED") {
      await bot.sendMessage(
        query.message.chat.id,
        "Accept the job before changing work status."
      );
      return;
    }

    if (action === "enroute") {
      await setJobStatus(
        assignment.job_id,
        "EN_ROUTE"
      );

      await updateAssignmentMessage(
        assignment,
        `${jobCard(job)}\n\n🚐 <b>EN ROUTE</b>`,
        enRouteKeyboard(
          assignment.id
        )
      );

      await logEvent(
        assignment.job_id,
        "EN_ROUTE",
        assignment.locksmith_id
      );

      return;
    }

    if (action === "arrived") {
      await setJobStatus(
        assignment.job_id,
        "ARRIVED"
      );

      await updateAssignmentMessage(
        assignment,
        `${jobCard(job)}\n\n📍 <b>ARRIVED</b>`,
        arrivedKeyboard(
          assignment.id
        )
      );

      await logEvent(
        assignment.job_id,
        "ARRIVED",
        assignment.locksmith_id
      );

      return;
    }

    if (action === "complete") {
      await setJobStatus(
        assignment.job_id,
        "REPORTING"
      );

      reportSessions.set(
        userId,
        {
          step: "final_amount",
          assignmentId:
            String(assignment.id),
          jobId:
            String(assignment.job_id)
        }
      );

      await updateAssignmentMessage(
        assignment,
        `${jobCard(job)}\n\n🧾 <b>REPORTING</b>`
      );

      await bot.sendMessage(
        query.message.chat.id,
        `${job.job_code}\nFinal customer price? Example: 180`
      );

      return;
    }
  }

  if (parts[0] === "rp") {
    const assignmentId = parts[1];
    const action = parts[2];

    const verification =
      await verifyAssignmentOwner(
        assignmentId,
        userId
      );

    if (!verification.ok) {
      await bot.sendMessage(
        query.message.chat.id,
        verification.reason
      );
      return;
    }

    const assignment =
      verification.assignment;

    if (action === "material") {
      reportSessions.set(
        userId,
        {
          step: "material_name",
          assignmentId:
            String(assignment.id),
          jobId:
            String(assignment.job_id)
        }
      );

      await bot.sendMessage(
        query.message.chat.id,
        "Material / part name? Example: Key blank, Remote, Deadbolt"
      );

      return;
    }

    if (action === "materials_done") {
      reportSessions.set(
        userId,
        {
          step: "payment",
          assignmentId:
            String(assignment.id),
          jobId:
            String(assignment.job_id)
        }
      );

      await bot.sendMessage(
        query.message.chat.id,
        "Payment method?",
        {
          reply_markup:
            paymentKeyboard(
              assignment.id
            )
        }
      );

      return;
    }

    if (action === "pay") {
      const method =
        parts.slice(3).join(":") ||
        "Other";

      await savePayment(
        assignment.job_id,
        method
      );

      reportSessions.set(
        userId,
        {
          step: "tip",
          assignmentId:
            String(assignment.id),
          jobId:
            String(assignment.job_id)
        }
      );

      await bot.sendMessage(
        query.message.chat.id,
        `Payment: ${method}\nTip amount? Enter 0 if no tip.`
      );

      return;
    }

    if (action === "skip_notes") {
      await finalizeCompletedJob(
        userId,
        assignment,
        "",
        query.message.chat.id
      );

      return;
    }
  }
});

bot.on("message", async (msg) => {
  if (!pool) return;
  if (!msg.text) return;
  if (msg.text.startsWith("/")) return;

  const userId =
    String(msg.from?.id || "");

  const session =
    reportSessions.get(userId);

  if (!session) return;

  const verification =
    await verifyAssignmentOwner(
      session.assignmentId,
      userId
    );

  if (!verification.ok) {
    reportSessions.delete(userId);

    await bot.sendMessage(
      msg.chat.id,
      verification.reason
    );

    return;
  }

  const assignment =
    verification.assignment;

  const text =
    msg.text.trim();

  if (session.step === "final_amount") {
    const amount =
      parseAmount(text);

    if (amount === null) {
      await bot.sendMessage(
        msg.chat.id,
        "Enter a number, for example: 180"
      );
      return;
    }

    await saveFinalAmount(
      assignment.job_id,
      amount
    );

    reportSessions.set(
      userId,
      {
        ...session,
        step: "materials_menu"
      }
    );

    await bot.sendMessage(
      msg.chat.id,
      `Final price saved: ${money(amount)}\nAdd actual cost of parts/materials used on this job.`,
      {
        reply_markup:
          materialsKeyboard(
            assignment.id
          )
      }
    );

    return;
  }

  if (session.step === "material_name") {
    reportSessions.set(
      userId,
      {
        ...session,
        step: "material_cost",
        materialName: text
      }
    );

    await bot.sendMessage(
      msg.chat.id,
      `Cost of "${text}"? Example: 32`
    );

    return;
  }

  if (session.step === "material_cost") {
    const cost =
      parseAmount(text);

    if (cost === null) {
      await bot.sendMessage(
        msg.chat.id,
        "Enter the material cost as a number, for example: 32"
      );
      return;
    }

    await addMaterial(
      assignment.job_id,
      session.materialName,
      cost
    );

    const materials =
      await getMaterials(
        assignment.job_id
      );

    const total =
      materials.reduce(
        (sum, item) =>
          sum + Number(item.cost),
        0
      );

    reportSessions.set(
      userId,
      {
        ...session,
        step: "materials_menu",
        materialName: undefined
      }
    );

    await bot.sendMessage(
      msg.chat.id,
      `Added: ${session.materialName} — ${money(cost)}\nMaterials total: ${money(total)}`,
      {
        reply_markup:
          materialsKeyboard(
            assignment.id
          )
      }
    );

    return;
  }

  if (session.step === "tip") {
    const tip =
      parseAmount(text);

    if (tip === null) {
      await bot.sendMessage(
        msg.chat.id,
        "Enter the tip as a number, or 0."
      );
      return;
    }

    await saveTip(
      assignment.job_id,
      tip
    );

    reportSessions.set(
      userId,
      {
        ...session,
        step: "notes"
      }
    );

    await bot.sendMessage(
      msg.chat.id,
      "Completion notes? Send a short note, or tap NO NOTES.",
      {
        reply_markup:
          completionNotesKeyboard(
            assignment.id
          )
      }
    );

    return;
  }

  if (session.step === "notes") {
    const notes =
      text.toUpperCase() === "SKIP"
        ? ""
        : text;

    await finalizeCompletedJob(
      userId,
      assignment,
      notes,
      msg.chat.id
    );

    return;
  }
});

app.get("/", (_req, res) => {
  res
    .type("text")
    .send(
      `Philly Bear Telegram Bot is running. Build ${BUILD_ID}`
    );
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service:
      "philly-bear-telegram-bot",
    build: BUILD_ID,
    multiLocksmith: true,
    privateAssignments: true,
    databaseConfigured:
      Boolean(DATABASE_URL),
    adminConfigured:
      Boolean(ADMIN_TELEGRAM_ID),
    apiConfigured:
      Boolean(INTERNAL_API_KEY),
    acceptTimeoutSeconds:
      JOB_ACCEPT_TIMEOUT_SECONDS
  });
});

app.post("/api/jobs", async (req, res) => {
  if (requireDb(res)) return;

  if (!INTERNAL_API_KEY) {
    res.status(503).json({
      ok: false,
      error:
        "INTERNAL_API_KEY not configured"
    });
    return;
  }

  const auth =
    String(
      req.headers.authorization ||
        ""
    );

  if (
    auth !==
    `Bearer ${INTERNAL_API_KEY}`
  ) {
    res.status(401).json({
      ok: false,
      error: "Unauthorized"
    });
    return;
  }

  try {
    const job =
      await createJob(
        req.body || {}
      );

    const routed =
      await routeJob(job.id);

    res.status(201).json({
      ok: true,
      id: job.id,
      job_code: job.job_code,
      routing: routed.ok
        ? {
            status: "OFFERED",
            locksmith_id:
              routed.locksmith.id,
            locksmith_name:
              routed.locksmith
                .display_name
          }
        : {
            status:
              "UNASSIGNED",
            reason:
              routed.reason
          }
    });
  } catch (err) {
    console.error(
      "/api/jobs:",
      err
    );

    res.status(400).json({
      ok: false,
      error: err.message
    });
  }
});

process.on("SIGINT", async () => {
  await bot.stopPolling();
  if (pool) await pool.end();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await bot.stopPolling();
  if (pool) await pool.end();
  process.exit(0);
});

await initDb();

setInterval(
  sweepExpiredAssignments,
  30_000
);

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Philly Bear Telegram Bot listening on ${PORT}; build ${BUILD_ID}; timeout ${JOB_ACCEPT_TIMEOUT_SECONDS}s`
    );
  }
);
