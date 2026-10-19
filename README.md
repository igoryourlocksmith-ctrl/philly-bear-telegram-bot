# Philly Bear Telegram Bot — v1.1

Build ID: `2026-10-18-telegram-v1.1-service-area-hours-tips`
Package version: `1.1.0`

## New central service ZIP allowlist

A new PostgreSQL table `service_zip_codes` controls where Philly Bear accepts jobs.

On the first start of v1.1, all existing active ZIPs from `locksmith_zip_coverage`
are automatically copied into the service allowlist. This prevents the upgrade from
suddenly blocking the ZIPs you already use.

Admin commands:
- `/servicezip add 19147 19148 19145`
- `/servicezip remove 19145`
- `/servicezips`

The allowlist is separate from each locksmith's personal ZIP coverage.

## Per-locksmith schedules

A new table `locksmith_service_hours` stores schedules by locksmith, service category,
and day of week.

Existing and newly added locksmiths receive default daily hours:
- `standard`: 08:00–19:00
- `vehicle_lockout`: 07:00–21:00
- `residential_lockout`: 07:00–21:00

Timezone: `America/New_York`.

Admin commands:
- `/sethours TELEGRAM_ID standard 08:00 19:00`
- `/sethours TELEGRAM_ID vehicle_lockout 07:00 21:00`
- `/sethours TELEGRAM_ID residential_lockout 07:00 21:00`
- `/hours TELEGRAM_ID`

The database schema already supports different schedules for different days; the current
admin command applies the chosen hours to all seven days.

## Routing

A locksmith is eligible only if all are true:
1. ZIP is in the central service allowlist.
2. Locksmith is active.
3. ZIP is in that locksmith's personal coverage.
4. Locksmith is currently inside their schedule for the service category.
5. Locksmith has not already declined/timed out on that job.

Priority and the existing 3-minute acceptance timeout remain unchanged.

## Availability API

New protected endpoint:
`POST /api/availability/check`

It checks ZIP + service category before the voice dispatcher asks for the full address.

## Tip accounting change

Tip method is now recorded separately:
- No tip
- Cash tip
- Non-cash tip

Cash tips:
- are stored internally;
- are NOT shown in the completed-job financial report;
- are NOT added to the amount owed to the technician, because the technician already has the cash.

Non-cash tips:
- are stored separately;
- appear as `Tip owed to technician`;
- are intended to be paid to the technician 100%;
- do not increase `Gross before labor/overhead`.

The final report no longer mixes tips into gross profit.

## Existing Railway variables

Keep:
- `TELEGRAM_BOT_TOKEN`
- `DATABASE_URL`
- `ADMIN_TELEGRAM_ID`
- `INTERNAL_API_KEY`
- `JOB_ACCEPT_TIMEOUT_SECONDS` (optional; default remains 180 seconds)
