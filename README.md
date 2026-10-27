# Node Starter 🚀

A production-ready **Fastify + TypeScript + Prisma** boilerplate with PostgreSQL, Adminer, Docker Compose, Swagger docs, dual JWT auth with refresh token rotation, RBAC, and more.

---

## Tech Stack

| Tool | Purpose |
|---|---|
| **Fastify v5** | High-performance HTTP framework |
| **TypeScript** | Full type safety |
| **Prisma** | ORM + auto migrations |
| **Vitest** | Blazing-fast test runner |
| **PostgreSQL** | Relational database |
| **Adminer** | Database admin UI |
| **Docker Compose** | Local infra orchestration |
| **Zod** | Schema & runtime validation |
| **@fastify/jwt** | Dual-namespace JWT authentication |
| **bcrypt** | Password + refresh token hashing |

---

## Project Structure

```
node-starter/
├── src/
│   ├── config/
│   │   └── env.ts                  # Env validation (Zod) — fails fast on bad config
│   ├── modules/                    # one folder per feature: identity, venue, booking, health
│   │   └── <feature>/
│   │       ├── <feature>.routes.ts      # Endpoints + schema, routes to the controller
│   │       ├── <feature>.controller.ts  # HTTP only: params in, response out
│   │       ├── <feature>.service.ts     # Business rules, reads
│   │       ├── <feature>.repository.ts  # ALL database queries (Prisma + raw SQL)
│   │       ├── <feature>.schema.ts      # JSON Schema / Zod validation
│   │       ├── <feature>.domain.ts      # Pure rules (optional)
│   │       └── mediators/               # One file per multi-step use-case (transaction + audit + events)
│   ├── plugins/
│   │   ├── cors.ts                 # CORS with origin whitelist
│   │   ├── jwt.ts                  # Dual JWT (access + refresh namespaces)
│   │   ├── prisma.ts               # Prisma client + lifecycle management
│   │   ├── security.ts             # Helmet + rate-limiting
│   │   └── swagger.ts              # OpenAPI 3.0 docs at /docs
│   ├── hooks/
│   │   ├── auth.hook.ts            # JWT authentication preHandler
│   │   └── authorize.hook.ts       # Role-based authorization preHandler
│   ├── utils/
│   │   ├── errors.ts               # AppError hierarchy (400/401/403/404/409/500)
│   │   └── response.ts             # Standardized response envelopes
│   ├── types/
│   │   └── index.ts                # Fastify type augmentations + shared interfaces
│   ├── app.ts                      # App builder (plugins, routes, error handler)
│   └── server.ts                   # Entry point + graceful shutdown
├── tests/
│   ├── setup.ts                    # Vitest global setup (env overrides, test DB)
│   └── user.test.ts                # Integration tests
├── prisma/
│   ├── schema.prisma               # DB schema (User + RefreshToken models)
│   └── seed.ts                     # Seed script (admin, or everything; see db:seed:admin)
├── vitest.config.ts                # Test runner configuration
├── docker-compose.yml              # PostgreSQL + Adminer services
├── Dockerfile                      # Multi-stage production image
├── .env.example                    # Environment variables template
└── tsconfig.json
```

---

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env and set strong secrets for ACCESS_TOKEN_SECRET and REFRESH_TOKEN_SECRET
```

### 3. Start the database

```bash
docker compose up -d
```

> PostgreSQL: `localhost:5432`
> Adminer UI: [http://localhost:8080](http://localhost:8080)
> Adminer login → Server: `postgres` | User: `postgres` | Pass: `postgres` | DB: `node_starter`

### 4. Run database migrations

```bash
npm run db:migrate
```

### 5. (Optional) Seed the database

Admins cannot register through the API, so the seed is how the first admin is created.

```bash
# Admin only (use this for a real / production database)
npm run db:seed:admin        # same as: npm run db:seed -- --admin-only

# Full development seed
npm run db:seed
```

| Command | Creates |
|---|---|
| `npm run db:seed:admin` | Roles and permissions, and the admin account. Nothing else. |
| `npm run db:seed` | The same, plus 8 areas (Karachi, Lahore), a demo owner (`demo.owner@sportra.local` / `Owner@12345`), 20 approved demo venues with courts and prices, and 60 days of bookable slots. Development only. |

The admin is `admin@sportra.local` / `Admin@12345` unless you set `ADMIN_SEED_EMAIL` and `ADMIN_SEED_PASSWORD` in `.env` before running. Both commands are safe to run again (existing data is kept). Admin login always needs the emailed code: `POST /api/v1/public/auth/login`, then `/login/verify-otp`.

### 6. Start the dev server

```bash
npm run dev
```

---

## API Endpoints

### Authentication

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/v1/users/signup` | No | Register a new user |
| `POST` | `/api/v1/users/login` | No | Login — returns access token + sets refresh cookie |
| `POST` | `/api/v1/users/refresh` | Cookie | Rotate refresh token, issue new access token |
| `POST` | `/api/v1/users/logout` | Cookie | Revoke refresh token, clear cookie |

### Users (JWT required)

| Method | Path | Role | Description |
|---|---|---|---|
| `GET` | `/api/v1/users` | Any | Paginated user list |
| `GET` | `/api/v1/users/:id` | Any | Get user by ID |
| `PATCH` | `/api/v1/users/:id` | Any | Update user profile |
| `POST` | `/api/v1/users` | ADMIN | Create a user with any role |
| `DELETE` | `/api/v1/users/:id` | ADMIN | Delete a user |

### Other

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/docs` | Swagger UI |

---

## Auth Flow

```
Login ──► Access Token (15m, Bearer header)
     └──► Refresh Token (7d, HttpOnly cookie)

Refresh ──► Revoke old refresh token (rotation)
       └──► New access token + new refresh token cookie
```

Refresh tokens are **rotated on every use** — each call to `/refresh` invalidates the old token and issues a fresh one, preventing replay attacks.

---

## Adding Authorization to a Route

```ts
import { authenticate } from '../../hooks/auth.hook'
import { authorize } from '../../hooks/authorize.hook'

// Any authenticated user
app.get('/profile', { preHandler: [authenticate] }, handler)

// Admin only
app.delete('/:id', { preHandler: [authenticate, authorize('ADMIN')] }, handler)
```

---

## Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Build for production |
| `npm start` | Run production build |
| `npm test` | Run all tests |
| `npm run db:migrate` | Run migrations (dev) |
| `npm run db:migrate:prod` | Run migrations (production) |
| `npm run db:generate` | Regenerate Prisma client |
| `npm run db:studio` | Open Prisma Studio |
| `npm run db:seed` | Full development seed (admin, areas, demo owner, 20 demo venues, slots) |
| `npm run db:seed:admin` | Seed only the roles and the admin account |
| `npm run db:reset` | Reset all migrations and data |

---

## Environment Variables

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

| Variable | Description | Default |
|---|---|---|
| `NODE_ENV` | Environment | `development` |
| `PORT` | Server port | `3000` |
| `HOST` | Bind host | `0.0.0.0` |
| `DATABASE_URL` | Prisma connection string | — |
| `ACCESS_TOKEN_SECRET` | JWT signing secret (min 16 chars) | — |
| `REFRESH_TOKEN_SECRET` | Refresh JWT secret (min 16 chars, different from access) | — |
| `ACCESS_TOKEN_EXPIRES_IN` | Access token expiry | `15m` |
| `REFRESH_TOKEN_EXPIRES_IN` | Refresh token expiry | `7d` |
| `ALLOWED_ORIGINS` | Comma-separated allowed CORS origins | `http://localhost:3000` |

---

## Adding a New Module

Layers, one file each. Keep every file small. Details: `../CLAUDE.md`, "Module layout".

1. Create `src/modules/<feature>/`
2. `<feature>.schema.ts`: JSON Schema (and Zod types) for body, query, params
3. `<feature>.repository.ts`: all queries in a `queries(db)` function, wrapped with `makeRepository(prisma, queries)` (`src/lib/repository.ts`) so `repo.transaction(fn)` gives the same queries bound to a transaction
4. `<feature>.service.ts`: business rules and reads, built from the repository
5. `mediators/<use-case>.mediator.ts`: only for multi-step work (several writes in one transaction, audit, outbox events)
6. `<feature>.controller.ts`: reads the request, calls the service or a mediator, sends the response. No rules, no SQL
7. `<feature>.routes.ts`: endpoints, hooks and schemas, pointing at controller handlers
8. Register routes in `src/app.ts`

---

## Docker (Production)

```bash
docker build -t node-starter .
docker run -p 3000:3000 --env-file .env node-starter
```

Or uncomment the `app` service in `docker-compose.yml` for a fully containerized setup.
