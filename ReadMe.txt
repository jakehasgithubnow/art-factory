Art Factory

A production-ready pipeline for turning real-world locations into curated “paintings,” reviewing them in lightweight admin UIs, and publishing approved pieces to external storefronts and automations.

This README is your single source of truth. It explains how the app is wired end-to-end, how each subsystem interacts, which environment variables you need, how jobs move through the pipeline, and what the admin UIs and APIs do.

⸻

Table of contents
	•	What this app does (the big picture)
	•	Architecture at a glance
	•	Runtime components
	•	Directory map
	•	Configuration & environment
	•	Data model
	•	Queues & workers
	•	Workflow stages
	•	APIs & Admin UIs
	•	Services (integrations)
	•	Operational behavior
	•	Local development
	•	Deployment
	•	Troubleshooting & observability
	•	Extending the system
	•	Security considerations
	•	Known gaps & TODOs

⸻

What this app does (the big picture)
	1.	Ingest a “catchment” (a geographic area with a name and centroid).
	2.	Discover & enrich locations inside that catchment (e.g., via Google Places).
	3.	Collect photos (via Google CSE or Openverse) for each location.
	4.	Moderate photos in a simple web UI; approving a photo uploads it to Cloudinary and enqueues artwork generation.
	5.	Generate artwork (AI “painting”) and store it along with description and mockups.
	6.	Moderate artwork in a second UI; approving artwork enqueues publish.
	7.	Publish approved pieces to Shopify and/or trigger automations (n8n webhook).
	8.	Monitor progress via a live Server-Sent Events feed and recent rollups.

Everything is event-driven using BullMQ backed by Redis, with PostgreSQL as the system of record.

⸻

Architecture at a glance

flowchart LR
  subgraph Client/Admin
    U1[Operator UI]
    U2[Photo Moderation UI]
    U3[Artwork Moderation UI]
  end

  subgraph API(Express API)
    A1[/POST /catchments/]
    A2[/GET /admin/photos/ .../artworks/]
    A3[/POST /moderate/photo/:id/]
    A4[/POST /moderate/artwork/:id/]
    A5[/GET /events (SSE)/]
    A6[/GET /admin/recent/]
    A7[/GET/POST System + Style Prompts/]
  end

  subgraph Data
    DB[(PostgreSQL)]
    R[(Redis)]
  end

  subgraph Jobs(BullMQ)
    Q1[q:catchment]
    Q2[q:location]
    Q3[q:photo]
    Q4[q:artwork]
    Q5[q:publish]
  end

  subgraph External
    G[Google CSE & Places]
    OV[Openverse]
    CLD[Cloudinary]
    FM[Frame-mock service]
    OAI[OpenAI / PIAPI]
    SH[Shopify]
    N8N[n8n Webhook]
  end

  U1 --> A1
  U2 --> A2 --> A3
  U3 --> A2 --> A4
  A1 --> DB
  A1 --> Q1
  A2 --> DB
  A3 --> DB
  A3 --> Q4
  A4 --> DB
  A4 --> Q5
  A5 --> DB
  A6 --> DB

  Q1 <---> R
  Q2 <---> R
  Q3 <---> R
  Q4 <---> R
  Q5 <---> R

  Q1 --> G
  Q2 --> G
  Q3 --> G & OV --> DB
  Q3 --> CLD
  Q4 --> OAI
  Q4 --> FM
  Q5 --> SH
  Q5 --> N8N

  Q1 --> DB
  Q2 --> DB
  Q3 --> DB
  Q4 --> DB
  Q5 --> DB


⸻

Runtime components
	•	Express server (app/server/app.js)
Exposes ingestion, moderation, health, SSE, and admin endpoints. Adds lightweight rate limiting and (optional) API key auth.
	•	BullMQ queues & workers (app/queue/*.js)
Five queues (catchment, location, photo, artwork, publish) share a Redis connection and uniform retry/backoff semantics. workers.js binds processors from app/workflows/*.
	•	PostgreSQL (app/db/schema.sql)
Holds catchments, locations, photos, artwork, and prompt configuration with indices and guardrails.
	•	Redis
Backing store for BullMQ queues and job state.
	•	Integrations / services (app/services/*)
Adapters for Cloudinary, Google, Openverse, OpenAI, frame-mock, Shopify, and n8n with consistent logging and retry behavior.

⸻

Directory map

app/
  config/env.js                # Env loading & typed helpers
  db/
    client.js                  # Knex client
    schema.sql                 # Full DB schema & indices
    migrations/                # One-off SQL migration(s)
    stylePrompts.js            # DAL for style_prompts
    systemPrompts.js           # DAL for system_prompts
  queue/
    queues.js                  # Queue factories (BullMQ)
    workers.js                 # Worker wiring & structured logs
  scripts/
    migrate.js                 # Apply schema.sql to DB
  server/
    helpers/validation.js      # Input validation helpers
    middleware/                # rateLimit & requireApiKey
    routes/                    # APIs & lightweight admin UIs
      admin/
        stylePrompts.js        # REST API for style prompts
        stylePromptsUI.js      # Simple HTML UI (system+style prompts)
        systemPrompts.js       # REST API for system prompts
      adminRecent.js           # Rollup snapshot for operator UI
      catchments.js            # Ingest & requeue
      events.js                # SSE stream of recent rollups
      health.js
      moderationArtwork.js     # Approve/reject artwork + mockups + publish enqueue
      moderationArtworkUI.js   # HTML UI for artwork moderation
      moderationPhotos.js      # Approve/reject photos + Cloudinary + artwork enqueue
      moderationUI.js          # HTML UI for photo moderation
    app.js                     # Express app factory + wiring + error handling
  services/
    artworkTracker.js          # In-memory processing guard (dedupe)
    cloudinary.js              # Upload + metadata with retries
    framemock.js               # Frame-mock client with retries & timeouts
    google.js                  # Google CSE images + Places details
    n8n.js                     # Outbound webhook
    openai.js                  # Chat & JSON helpers (OpenAI/PIAPI)
    openverse.js               # Openverse image search
    shopify.js                 # Shopify Admin REST (partially shown)
  workflows/
    artwork.js                 # Processor: generate artwork (used by q:artwork)
    catchment.js               # Processor: seed locations for a catchment
    locations.js               # Processor: enrich locations
    photos.js                  # Processor: source & score photos
    publish.js                 # Processor: publish to Shopify & automations
  index.js                     # (Entry point that boots server/workers)
.render.yaml                   # (Render.com deploy config)
package.json
README.md (this file)

Note: Some workflow and route files referenced by the app exist in the repo but were not fully included in the excerpt. This README documents their intended responsibilities and integration points based on how they are used.

⸻

Configuration & environment

All configuration is centralized in app/config/env.js, which provides typed accessors:

Required to boot
	•	DATABASE_URL – PostgreSQL connection string (e.g., postgres://user:pass@host:5432/db)
	•	REDIS_URL – Redis connection string (e.g., redis://:pass@host:6379/0)

Server
	•	PORT (default 3000)
	•	INGEST_KEY – optional; when set, write endpoints require x-api-key/x-ingest-key headers

OpenAI / PIAPI
	•	OPENAI_API_KEY – for image/description generation in workflows
	•	(Optional) PIAPI_API_KEY – referenced in services/openai.js (env aliasing supported there)

Image search
	•	Google CSE
	•	GOOGLE_API_KEY
	•	GOOGLE_CX  ← used by services/google.js
	•	GOOGLE_CSE_ID  ← loaded in env.js as googleCseId (see Known gaps)
	•	Openverse
	•	OPENVERSE_API_KEY (optional; adds Authorization header)

Google Places
	•	GOOGLE_PLACES_API_KEY – for text search + place details

Cloudinary
	•	CLOUDINARY_CLOUD_NAME
	•	CLOUDINARY_API_KEY
	•	CLOUDINARY_API_SECRET

Frame-mock (mockup generator)
	•	FRAME_MOCK_URL – required to generate framed mockups
	•	FRAME_MOCK_API_KEY – optional bearer token (if service requires auth)
	•	frameUrl1, frameUrl2, frameUrl3 – optional default frame image URLs (note unusual lowercase names—see Known gaps)

Paint service
	•	PAINT_ENDPOINT – optionally used in artwork generation workflows

Shopify
	•	SHOPIFY_SHOP – shop domain or URL (e.g., myshop.myshopify.com)
	•	SHOPIFY_ACCESS_TOKEN
	•	SHOPIFY_API_VERSION (default 2024-04)

Queues / workers
	•	QUEUE_PREFIX (default art-factory)
	•	QUEUE_ATTEMPTS (default 5)
	•	QUEUE_BACKOFF_MS (default 1000)
	•	QUEUE_REMOVE_ON_COMPLETE (default true)
	•	QUEUE_REMOVE_ON_FAIL (default false)
	•	Per-queue concurrency:
	•	CONCURRENCY_CATCHMENT (default 3)
	•	CONCURRENCY_LOCATION (default 3)
	•	CONCURRENCY_PHOTO (default 4)
	•	CONCURRENCY_ARTWORK (default 2)
	•	CONCURRENCY_PUBLISH (default 2)

⸻

Data model

Managed via app/db/schema.sql (applied by app/scripts/migrate.js). The schema is idempotent and guarded by indices/constraints:

Tables
	•	catchments
	•	id uuid PK, name, lat, lon, intro?, shopify_id?, processed boolean default false, created_at
	•	Indices & guards:
	•	CHECK lat ∈ [-90,90], CHECK lon ∈ [-180,180]
	•	Unique (lower(name), lat, lon) to prevent duplicates
	•	Unique shopify_id when present
	•	locations
	•	id uuid PK, catchment_id FK, name, address?, category?, description?, search_term?
	•	Google enrichment fields: g_place_id, g_*, g_photo_refs jsonb
	•	Flags: processed boolean default false, created_at
	•	Indices: locations_unique_place_per_catchment (catchment_id, lower(name)), idx_locations_catchment, idx_locations_created_at
	•	photos
	•	id uuid PK, location_id FK, src_url, kept boolean default false, score numeric CHECK 0..1, cloudinary_id?, secure_url?, processed boolean default false
	•	Openverse metadata columns (license, creator, etc.)
	•	Indices: unique (location_id, src_url), unique cloudinary_id when present, idx_photos_location, idx_photos_created_at
	•	artwork
	•	id uuid PK, photo_id FK, image_url, description?, mockup_urls jsonb default [], shopify_id?, published boolean default false, created_at
	•	Indices: idx_artwork_photo, unique shopify_id when present, idx_artwork_created_at
	•	system_prompts
	•	id serial PK, key UNIQUE, text, enabled boolean default true, updated_at
	•	Seeded entries for concise descriptions & locations copy
	•	style_prompts
	•	id serial PK, text, enabled boolean default true, created_at, updated_at
	•	Index: idx_style_prompts_enabled

Admin rollups query counts locations, photos_total, photos_kept, artworks, and published per catchment for dashboards and SSE.

⸻

Queues & workers

Queues are created in app/queue/queues.js with shared IORedis connection and consistent defaults:
	•	Default job options
	•	Attempts: QUEUE_ATTEMPTS (exponential backoff, QUEUE_BACKOFF_MS)
	•	Remove on complete/fail according to env
	•	Namespaced with QUEUE_PREFIX (default: art-factory)
	•	Queues
	•	qCatchment, qLocation, qPhoto, qArtwork, qPublish
	•	Workers (app/queue/workers.js)
	•	Each queue is bound to a processor in app/workflows/*
	•	Per-queue concurrency configurable via env
	•	Emits structured JSON logs on lifecycle events (job_started, job_completed, job_failed, job_stalled, worker_error)
	•	Idempotency
	•	API enqueues with deterministic jobIds (e.g., catchment:<id>, artwork:<photoId>, publish:<artworkId>) to prevent duplicates.
	•	services/artworkTracker.js provides an in-memory deduper for artwork processing (consider persistent store in HA setups).

⸻

Workflow stages

The processors live in app/workflows/ (not fully shown, responsibilities inferred from routes & services).
	1.	catchment
Seed initial work for a catchment (e.g., expand to a list of candidate locations). May choose image provider (“google” vs “openverse”) based on the ingest request.
	2.	locations
For each candidate, enrich via services/google.getPlaceDetails(searchTerm) to populate address, website, geocoordinates, rating, and g_photo_refs.
	3.	photos
Source images via:
	•	services/google.imageSearch(query, num) (Google CSE)
	•	services/openverse.imageSearch(query, num) (Openverse)
Attach Openverse metadata, dedupe by (location_id, src_url), assign score, and set processed flags.
	4.	artwork
Given an approved photo:
	•	Upload to Cloudinary if needed (also done eagerly in moderation step).
	•	Generate painting & description using services/openai.chat/chatJson and configured system/style prompts.
	•	Persist artwork with image_url, description.
	•	Optionally call services.framemock.createMockups(...) to pre-generate mockups.
	5.	publish
Push approved artwork to Shopify (services/shopify), set shopify_id, mark as published, and notify external automations via services/n8n.sendProduct(payload).

⸻

APIs & Admin UIs

Health
	•	GET /health → { ok: true, time: ISO8601 }

Ingest & queue
	•	POST /catchments
Body:

{
  "name": "Lisbon, Baixa",
  "lat": 38.711,
  "lon": -9.139,
  "intro": "Historic center by the Tagus",
  "imageSource": "google" | "openverse"   // optional, default "google"
}

Behavior: Validates and inserts a catchment, then enqueues the catchment job (jobId=catchment:<id>).
Auth: Requires x-api-key if INGEST_KEY is set.
Rate limit: 60 req/min per IP.
Response: 202 Accepted { "id": "<uuid>" }

	•	POST /requeue/:stage/:id
Currently supports stage=catchment to re-enqueue the initial job deterministically.

Moderation – Photos
	•	UI: GET /admin/moderate/:catchmentId
Serves a minimal HTML grid (no framework) that calls the APIs below.
	•	GET /admin/photos?catchmentId=<uuid>
Returns all photos for a catchment with Openverse metadata.
	•	POST /moderate/photo/:id
Body: { "action": "approve" | "reject" }
	•	On approve:
	1.	photos.kept = true
	2.	If not already uploaded, uploads src_url to Cloudinary (folder art-factory/source, public_id=source_<photo.id>) and saves cloudinary_id, secure_url
	3.	Marks photos.processed = true
	4.	Enqueues artwork job (jobId=artwork:<photoId>)
	•	On reject: marks kept=false, processed=true
Auth: Requires x-api-key if INGEST_KEY is set.

Moderation – Artwork
	•	UI: GET /admin/moderate-artwork/:catchmentId
Displays pending pieces with Approve/Reject buttons.
	•	GET /admin/artworks?catchmentId=<uuid>&status=pending|approved|rejected
Lists artwork joined to photos & locations for a catchment, filtered by moderation status.
	•	POST /moderate/artwork/:id
Body: { "action": "approve" | "reject" }
	•	On reject: marks as explicitly not approved for publish.
	•	On approve:
	1.	Marks as approved for publish
	2.	Fetches artwork.image_url
	3.	Calls frame-mock to generate staged mockups, updates artwork.mockup_urls
	4.	Enqueues publish job (jobId=publish:<artworkId>)
Auth: Requires x-api-key if INGEST_KEY is set.

The moderation UIs are intentionally simple HTML+JS so operators can run them without any frontend build tooling.

Operator data & live updates
	•	GET /admin/recent
Returns the last 20 catchments with rollup counts: locations, photos total/kept, artworks, published. Useful for dashboards.
	•	GET /events (SSE)
Streams the same rollup payload every 2 seconds, plus an immediate snapshot on connect. Use this to power “recent activity” dashboards without polling.

Prompts admin
	•	UI: GET /admin/style-prompts-ui
Shows System Prompts and Style Prompts in one page; form submits update both.
	•	System prompts (JSON)
	•	GET /admin/system-prompts → { prompts: [...] }
	•	PUT /admin/system-prompts/:key with { text, enabled }
Upserts by key (e.g., location_intro_system, artwork_description_system, location_places_system).
	•	Style prompts (JSON)
	•	GET /admin/style-prompts → [{ id, text, enabled, ... }]
	•	POST /admin/style-prompts → create
	•	PATCH /admin/style-prompts/:id → update text
	•	PATCH /admin/style-prompts/:id/toggle → { enabled: boolean }
	•	DELETE /admin/style-prompts/:id

⸻

Services (integrations)

All adapters prefer timeouts, retries, and structured logging.
	•	Cloudinary (services/cloudinary.js)
	•	uploadImage(image, { folder, publicId, overwrite, ... }) with exponential backoff on 429/5xx and network flakiness.
	•	getImageMetadata(publicId) convenience for EXIF/context.
	•	Returns { secure_url, public_id } (plus legacy { url, id }) to persist on photos.
	•	Google (services/google.js)
	•	imageSearch(query, num) uses Custom Search (GOOGLE_API_KEY + GOOGLE_CX).
	•	getPlaceDetails(searchTerm) does text search → place details (GOOGLE_PLACES_API_KEY) to enrich locations.
	•	Openverse (services/openverse.js)
	•	imageSearch(query, num) returning results with license and attribution fields; maps neatly onto photos Openverse columns.
	•	OpenAI/PIAPI (services/openai.js)
	•	chat(system, user, temperature, model)
	•	chatJson({ system, user, schema, temperature, model, maxRetries }) enforcing JSON structure with graceful retry on malformed output. Workflows use these for titles/descriptions and prompt-driven generation.
	•	Frame-mock (services/framemock.js)
	•	createMockups({ frameUrl1, frameUrl2, frameUrl3, artUrl, orientation, enableInnerShadow }, { timeoutMs })
Posts JSON, handles timeouts/retries, returns an array of image URLs (imageUrl1..3). Used during artwork approval to generate staged product imagery.
	•	Shopify (services/shopify.js)
	•	Admin REST wrapper with auth headers, retry on 429/5xx. Used by publish stage to create products/variants/media, then persist artwork.shopify_id.
	•	n8n (services/n8n.js)
	•	sendProduct(payload) posts to a configured webhook (15s timeout). Use to fan-out events downstream (slack, email, sheets, etc.).

⸻

Operational behavior
	•	Rate limiting (server/middleware/rateLimit.js)
	•	60 requests/min per IP, windowed in memory.
	•	Adds X-RateLimit-Remaining & X-RateLimit-Reset headers.
	•	Note: in-memory (per process). For multi-instance deployments, use a shared limiter (e.g., Redis) or run the API behind a gateway.
	•	Auth (server/middleware/requireApiKey.js)
	•	If INGEST_KEY is set, write endpoints require x-api-key (or x-ingest-key) to match.
	•	If not set, endpoints are open (dev-friendly).
	•	Logging
	•	Structured JSON logs across app/server, services, and workers, including timestamps, request IDs, queue/worker context, durations, and error stacks.
	•	SSE
	•	/events streams JSON payloads and cleans up on client disconnect.
	•	Error handling
	•	API returns 500 { error: "internal_error" } with error details logged.
	•	Workers log failures with name/message/stack; BullMQ retried per config.

⸻

Local development

Prerequisites
	•	Node.js 18+ (ESM imports used)
	•	PostgreSQL 14+
	•	Redis 6+
	•	Cloudinary / Google / OpenAI / Shopify credentials as needed for your scenario

Install & configure

# clone
git clone <your-fork-url> art-factory && cd art-factory

# install (pick your tool)
pnpm install  # or: npm install / yarn

Create .env with at least:

DATABASE_URL=postgres://user:pass@localhost:5432/art_factory
REDIS_URL=redis://localhost:6379/0

# Optional, recommended for write protection in dev UIs
INGEST_KEY=dev-secret

# If you plan to fetch images via Google CSE
GOOGLE_API_KEY=...
GOOGLE_CX=...

# If you plan to use Openverse
OPENVERSE_API_KEY=...

# Cloudinary (for uploading approved photos)
CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...

# OpenAI/PIAPI
OPENAI_API_KEY=...

# Frame mock (to produce staged mockups on artwork approval)
FRAME_MOCK_URL=https://your-frame-mock.example.com/api/v1/mockups
FRAME_MOCK_API_KEY=...

# Shopify (for publish stage)
SHOPIFY_SHOP=myshop.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpat_...
SHOPIFY_API_VERSION=2024-04

If you want test-only runs, you can omit many keys; the app boots with just DB + Redis. Workflows that require missing keys should handle it gracefully, but moderation-time actions will be limited.

Initialize schema

node app/scripts/migrate.js
# => "Schema applied ✅"

Run the app

There’s an entrypoint at app/index.js that typically starts both server and workers.

node app/index.js
# Server listens on PORT (default 3000)
# Workers attach to all queues with configured concurrency

Visit:
	•	Photo moderation UI: http://localhost:3000/admin/moderate/<catchmentId>
	•	Artwork moderation UI: http://localhost:3000/admin/moderate-artwork/<catchmentId>
	•	Prompts UI: http://localhost:3000/admin/style-prompts-ui
	•	Live events (SSE): http://localhost:3000/events
	•	Recent rollup: http://localhost:3000/admin/recent
	•	Health: http://localhost:3000/health

Ingest a catchment (example)

curl -X POST http://localhost:3000/catchments \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: dev-secret' \
  -d '{
    "name": "Lisbon - Baixa",
    "lat": 38.711,
    "lon": -9.139,
    "intro": "Historic center by the Tagus",
    "imageSource": "openverse"
  }'
# => { "id": "..." }

Workers will take it from there. Use /admin/recent or /events to watch progress.

⸻

Troubleshooting & observability
	•	Can’t connect to DB/Redis: verify DATABASE_URL / REDIS_URL and that services are reachable from your container/host.
	•	429s or 5xx from 3rd parties: adapters in /services already retry with exponential backoff and log details (HTTP status, attempt, delays).
	•	Jobs not progressing: check worker logs for job_failed events, and validate required env vars for that stage.
	•	Moderation UI actions failing: if INGEST_KEY is set, ensure x-api-key is provided in the page’s input box before clicking Approve/Reject (the UI forwards it with the request).
	•	SSE not updating: browser might buffer; ensure no proxies are buffering the stream and that the connection stays open.

⸻

Extending the system
	•	Add a new image provider: implement services/myProvider.imageSearch(), then branch in the photos workflow based on imageSource.
	•	Add new mockup styles: host new frameUrl* assets, pass them into framemock.createMockups() when approving artwork.
	•	Publish to additional channels: extend workflows/publish.js to fan-out to more services and persist their IDs on artwork.
	•	Richer prompts: add/edit system_prompts and style_prompts via the admin UI or APIs; workflows should read enabled prompts in order.

⸻

Security considerations
	•	API key protection: set INGEST_KEY in all non-local environments so write endpoints can’t be abused.
	•	Least privilege: use dedicated Shopify & Cloudinary keys with scoping.
	•	PII & licensing: Openverse and Google results include license/creator metadata; the photo moderation UI surfaces these. Respect attribution and license terms downstream.
	•	Webhooks: the n8n URL is currently hard-coded in services/n8n.js. Consider moving to env var and restricting inbound IPs on the n8n side.

⸻

Known gaps & TODOs

These are code-level issues you should address early:
	1.	Artwork moderation columns missing in schema
Routes reference artwork.approved_for_publish and artwork.moderated_at, but schema.sql does not define them.
Fix: add migration:

ALTER TABLE artwork
  ADD COLUMN IF NOT EXISTS approved_for_publish boolean,
  ADD COLUMN IF NOT EXISTS moderated_at timestamptz;

Update queries accordingly.

	2.	Dropping unique on artwork.photo_id (migration mismatch)
app/db/migrations/20250816_drop_artwork_photoid_unique.sql runs:

ALTER TABLE artwork DROP CONSTRAINT artwork_unique_per_photo;

But schema.sql creates a unique index named artwork_unique_per_photo, not a table constraint.
Fix: use:

DROP INDEX IF EXISTS artwork_unique_per_photo;

Decide whether multiple artworks per photo are desired; if not, keep the unique index and remove the migration.

	3.	Frame-mock call signature mismatch
services/framemock.createMockups(...) expects an object { artUrl, frameUrl1, ... }, but routes/moderationArtwork.js calls it with only a string (createMockups(art.image_url)).
Fix: change to:

const mockupUrls = await createMockups({
  artUrl: art.image_url,
  frameUrl1: env.frameUrl1,
  frameUrl2: env.frameUrl2,
  frameUrl3: env.frameUrl3,
  orientation: 'horizontal',
  enableInnerShadow: true
});


	4.	Google CSE env var naming
env.js reads GOOGLE_CSE_ID into env.googleCseId, but services/google.js uses process.env.GOOGLE_CX.
Fix: standardize on one name (e.g., GOOGLE_CX) and update env.js and/or services/google.js.
	5.	Operator UI import
app/server/app.js imports ./routes/operatorUI.js, which isn’t present in the listed files.
Fix: add the route or remove the import.
	6.	In-memory rate limiter & tracker
rateLimit and artworkTracker are per-process.
Fix: for HA deployments, use Redis-backed implementations (e.g., rate-limiter-flexible with Redis) and persist the artwork de-dupe state.
	7.	Hard-coded n8n webhook
Move the URL into an env var (N8N_WEBHOOK_URL) and guard secrets in logs.
	8.	Shopify service partial
Ensure services/shopify.js exposes the needed helpers (product create, media upload, collection linkage) and uses the env.shop normalization already present.
	9.	Lowercase frame URL envs
env.js uses frameUrl1/2/3 (lowercase). Consider switching to FRAME_URL1/2/3 for consistency with other envs.

⸻

Example end-to-end flow
	1.	Ingest: POST /catchments → DB row created → q:catchment job enqueued.
	2.	Locations: catchment processor seeds + enriches locations (Google Places) → DB rows inserted.
	3.	Photos: locations processor queries Google CSE/Openverse → photos inserted with metadata.
	4.	Photo moderation: operator approves a photo → Cloudinary upload → q:artwork job enqueued.
	5.	Artwork generation: workflow composes prompts (system + enabled style prompts), calls OpenAI, saves artwork with image_url & description.
	6.	Artwork moderation: operator approves → frame-mock called → mockup_urls saved → q:publish job enqueued.
	7.	Publish: workflow creates Shopify product (and/or calls n8n) → artwork.shopify_id set → artwork.published = true.
	8.	Observe: /events SSE shows rollups incrementing for photos kept, artworks, and published.

⸻

That’s the complete picture. If you’re integrating or extending, start by wiring environment variables, run the schema script, post a catchment, and watch the queues do the rest.