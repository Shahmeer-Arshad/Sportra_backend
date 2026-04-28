# Node Starter 🚀

A production-ready **Fastify + TypeScript + Prisma** boilerplate with PostgreSQL, Adminer, Docker Compose, Swagger docs, JWT auth, and more.

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
| **@fastify/jwt** | JWT authentication |

---

## Project Structure

```
node-starter/
├── src/
│   ├── config/
│   │   └── env.ts                  # Env validation (Zod)
│   ├── modules/
│   │   └── user/
│   │       ├── user.controller.ts  # Route handlers
│   │       ├── user.mediator.ts    # Operations controller
│   │       ├── user.repository.ts  # Database state changes
│   │       ├── user.routes.ts      # Fastify routing registers
│   │       ├── user.schema.ts      # Validations
│   │       ├── user.service.ts     # Business logic
│   ├── plugins/
│   │   ├── cors.ts
│   │   ├── jwt.ts
│   │   ├── prisma.ts               
│   │   ├── security.ts             
│   │   └── swagger.ts
│   ├── hooks/
│   │   └── auth.hook.ts            # Authentication interceptors
│   ├── utils/
│   │   ├── errors.ts               
│   │   └── response.ts             
│   ├── types/
│   │   └── index.ts                
│   ├── app.ts                      
│   └── server.ts                   
├── tests/
│   └── user.test.ts                # Integrated tests
├── prisma/
│   ├── schema.prisma               # DB schema
│   └── seed.ts                     # Seed script
├── docker-compose.yml              # PostgreSQL + Adminer
├── Dockerfile                      # Multi-stage production image
├── .env                            # Environment variables
└── tsconfig.json
```

---

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Start the database

```bash
docker compose up -d
```

> PostgreSQL: `localhost:5432`
> Adminer UI: [http://localhost:8080](http://localhost:8080)
> Adminer login → Server: `postgres` | User: `postgres` | Pass: `postgres` | DB: `node_starter`

### 3. Run database migrations

```bash
npm run db:migrate
```

### 4. (Optional) Seed the database

```bash
npm run db:seed
```

### 5. Start the dev server

```bash
npm run dev
```

---

## API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/docs` | No | Auto Swagger UI |
| `POST` | `/api/v1/users/signup` | No | Public registration |
| `POST` | `/api/v1/users/login` | No | Emits active JWT |
| `GET` | `/api/v1/users` | JWT | Paginated list |

---

## Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Build for production |
| `npm start` | Run production build |
| `npm run db:migrate` | Run migrations (dev) |
| `npm run db:migrate:prod` | Run migrations (production) |
| `npm run db:generate` | Regenerate Prisma client |
| `npm run db:studio` | Open Prisma Studio |
| `npm run db:seed` | Seed the database |
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
| `DATABASE_URL` | Prisma connection string | — |
| `JWT_SECRET` | JWT signing secret | — |
| `JWT_EXPIRES_IN` | Token expiry | `7d` |

---

## Adding a New Module

1. Create a new folder `src/modules/<feature>/`
2. Add `<feature>.schema.ts` — Zod + JSON Schema
3. Add `<feature>.service.ts` — Prisma queries
4. Add `<feature>.controller.ts` — Request/reply handling
5. Add `<feature>.routes.ts` — Register with Fastify
6. Register routes in `src/app.ts`

---

## Docker (Production)

```bash
docker build -t node-starter .
docker run -p 3000:3000 --env-file .env node-starter
```

Or use the commented-out `app` service in `docker-compose.yml`.
