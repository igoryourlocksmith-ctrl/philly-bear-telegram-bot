# Philly Bear Telegram Bot — v1 Multi-Locksmith

Build ID: `2026-10-13-telegram-v1-multilocksmith-3min`

This is the **first production architecture**, already designed for multiple locksmiths.

## Core privacy rule

There is **no shared job channel**.

A new job is first routed by ZIP code. Only after assignment does the bot send the job card to **one locksmith's private Telegram chat**.

Other locksmiths:
- do not receive the card;
- cannot see it in `/myjobs`;
- cannot use its buttons;
- cannot access the assignment by guessing a callback.

Every callback re-checks:
1. the current assignment;
2. the Telegram User ID;
3. that the assignment is still active.

## ZIP routing

Each locksmith has exact 5-digit ZIP coverage and a priority.

Example:

- Igor: 19147 priority 10
- Alex: 19147 priority 20
- Alex: 19148 priority 10

For a 19147 job:
1. Igor receives the card first.
2. If Igor declines or does not accept before timeout, his card becomes expired/reassigned.
3. Alex receives the job next.
4. No other locksmith sees it.

Within equal priority, the bot prefers the locksmith who has gone longest without receiving an assignment.

## Job flow

`NEW → OFFERED → ACCEPTED → EN_ROUTE → ARRIVED → REPORTING → COMPLETED`

Alternate outcomes:
- `DECLINED`
- `TIMEOUT`
- `CANCELLED`
- `UNASSIGNED`

## Completion report

The assigned locksmith records:
- final customer price;
- one or more materials / parts;
- actual material cost;
- payment method;
- tip;
- completion notes.

The bot calculates:
- materials total;
- total collected;
- gross before labor / overhead.

## Railway variables

Required:

- `TELEGRAM_BOT_TOKEN`
- `DATABASE_URL`

Admin:

- `ADMIN_TELEGRAM_ID`

Security for future AI integration:

- `INTERNAL_API_KEY`

Optional:

- `JOB_ACCEPT_TIMEOUT_SECONDS`
  - default: `180` seconds / 3 minutes
  - minimum: 60 seconds

## Locksmith onboarding

Every locksmith must first open `@PhillyBearDispatcherBot` and send:

`/myid`

They send the numeric Telegram User ID to the administrator.

Admin then runs:

`/addlocksmith TELEGRAM_ID Name`

Example:

`/addlocksmith 123456789 Alex`

Assign ZIP coverage:

`/addzip TELEGRAM_ID ZIP PRIORITY`

Example:

`/addzip 123456789 19147 10`

A lower number means higher priority.

Deactivate a locksmith temporarily:

`/setactive TELEGRAM_ID off`

Reactivate:

`/setactive TELEGRAM_ID on`

List all locksmiths and coverage:

`/locksmiths`

## Locksmith commands

- `/start`
- `/myid`
- `/mycoverage`
- `/myjobs`

A locksmith sees only jobs currently assigned to that locksmith.

## Test routing

Admin can create a test order:

`/testjob 19147`

The card goes only to the highest-priority active locksmith covering `19147`.

## Future AI integration

The voice dispatcher will create jobs through:

`POST /api/jobs`

Authorization:

`Authorization: Bearer <INTERNAL_API_KEY>`

Example body:

```json
{
  "customer_name": "John Smith",
  "customer_phone": "+12155550123",
  "language": "English",
  "service": "Vehicle Lockout",
  "vehicle": "2024 Kia Seltos",
  "problem": "Key locked inside vehicle",
  "zip_code": "19147",
  "address": "2040 S 13th St, Philadelphia, PA 19148",
  "location_detail": "Vehicle on street",
  "estimate_min": 120,
  "estimate_max": 160,
  "requested_time": "ASAP",
  "notes": "Customer can see the key inside."
}
```

The Telegram service then handles ZIP routing automatically.

## Database tables

- `locksmiths`
- `locksmith_zip_coverage`
- `jobs`
- `job_assignments`
- `materials`
- `job_events`

The schema is created automatically at startup.
