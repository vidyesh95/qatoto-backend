# QAToto Backend — Beginner's Guide 🚀

## The Big Picture

Your project is an API server. It waits for HTTP requests (from a browser, mobile app, or another service), processes them, and sends back JSON responses. That's it!

Think of it like a restaurant:

| Restaurant             | Your Server                                                     |
| :--------------------- | :-------------------------------------------------------------- |
| **Front door**         | `index.ts` — opens the restaurant (starts the server)           |
| **Dining room layout** | `app.ts` — sets up rules, security, and where to seat customers |
| **Menu sections**      | `routes/` — "appetizers are here, mains are there"              |
| **Waiters**            | `controllers/` — take the order, bring back the food            |
| **Kitchen**            | `services/` — actually cook the food (business logic)           |
| **Fridge/pantry**      | `db/` — where the raw ingredients are stored (database)         |
| **House rules**        | `middleware/` — "no shoes, no shirt, no service"                |
| **Recipe standards**   | `types/` — what a "plate of food" should look like              |
| **Manager's notebook** | `config/` — restaurant hours, staff passwords, etc.             |

---

## Step 1: Where It All Begins — `index.ts`

This is the entry point. When you run `pnpm run dev`, Node.js executes this file first.

`pnpm run dev` → `tsx watch src/index.ts` → **your server starts!**

Here's what it does, in order:

1.  **`import 'dotenv/config'`**: Loads `.env` file into `process.env`.
2.  **`import config`**: Validates all env vars with Zod.
3.  **`import app`**: Creates Express app with all middleware & routes.
4.  **`http.createServer(app)`**: Wraps it in an HTTP server.
5.  **`server.listen(port)`**: Starts listening on port 8000.
    - ✅ 'Server running on port 8000'
    - Register graceful shutdown: `SIGTERM` / `SIGINT` → close cleanly.

### Why does the order matter?

- **`dotenv/config` must be first**: It loads your `.env` file (passwords, port, etc.) into `process.env`.
- **Config validates next**: If `DATABASE_URL` is missing, the app crashes immediately with a clear error instead of failing mysteriously later.
- **Then the app is built**: Routes, middleware, everything.
- **Finally, the server starts listening**: Ready for requests!

---

## Step 2: The `.env` File

```env
PORT=8000
DATABASE_URL=postgres://user:password@localhost:5432/qatotodb
NODE_ENV=development
BETTER_AUTH_SECRET=BETTER_AUTH_SECRET_HERE
FRONTEND_URL=http://localhost:3000
```

These are secrets and settings that change between environments (your laptop vs. production server). They're never committed to git (listed in `.gitignore`).

The `.env.example` file is the template — it **IS** committed so teammates know which variables they need.

---

## Step 3: Config — `config/index.ts`

```typescript
const envSchema = z.object({
  PORT: z.coerce.number().default(8000),
  DATABASE_URL: z.string().url(),
  // ...
});
export const config = envSchema.parse(process.env);
```

**What it does:** Takes the raw `process.env` (which is all strings) and:

- **Validates**: Is `DATABASE_URL` a real URL? Is `PORT` a number?
- **Converts types**: `"8000"` (string) → `8000` (number).
- **Sets defaults**: No `PORT`? Use `8000`.
- **Fails fast**: If anything is wrong, the server crashes at startup with a clear message like _"DATABASE_URL: Expected string, received undefined"_.

**Why?** Without this, you might deploy to production, everything starts fine, then 3 hours later a request crashes because `DATABASE_URL` was never set. With Zod validation, you know immediately.

---

## Step 4: The App — `app.ts`

This is the heart of your server. It creates the Express application and plugs in middleware and routes.

```typescript
const app = express();

// 1. Security & parsing middleware (runs on EVERY request)
app.use(helmet());          // Security headers
app.use(cors({...}));       // Who can call this API
app.use(requestId);         // Tag each request with a UUID
app.use(logger("dev"));     // Log each request to console
app.use(express.json());    // Parse JSON request bodies
app.use(cookieParser());    // Parse cookies

// 2. Routes (match specific paths)
app.use("/", indexRouter);
app.use("/users", usersRouter);

// 3. Error handling (catches everything that falls through)
app.use(notFoundHandler);   // No route matched → 404
app.use(errorHandler);      // Something threw an error → 500
```

> [!IMPORTANT]
> **Order matters!** Middleware runs top-to-bottom. Security middleware must come before routes, and error handlers must come last.

---

## Step 5: Middleware — `middleware/`

Middleware are functions that run between receiving a request and sending a response. Think of them as checkpoints:

`Request` → `[helmet]` → `[cors]` → `[requestId]` → `[logger]` → `[json parser]` → `[route]` → `Response`
↓
`[error handler]`

### Your middleware:

| File               | What it does                                                                                                                             |
| :----------------- | :--------------------------------------------------------------------------------------------------------------------------------------- |
| `request-id.ts`    | Gives each request a unique ID (UUID) for debugging. If you see an error in logs, you can trace it back to the exact request.            |
| `not-found.ts`     | If no route matched, creates a 404 error and passes it to the error handler.                                                             |
| `error-handler.ts` | Catches ALL errors and sends a clean JSON response. In development it includes the stack trace; in production it hides internal details. |
| `validate.ts`      | Checks that request data (body/params/query) matches a Zod schema. Rejects bad data with a 400 error before it reaches your controller.  |

### Every middleware has the same signature:

```typescript
function myMiddleware(req: Request, res: Response, next: NextFunction) {
  // Do something with the request
  next(); // ← Pass to the NEXT middleware/route. If you don't call this, the request hangs!
}
```

---

## Step 6: Routes — `routes/`

Routes are the menu — they define what URLs your API responds to.

### `routes/index.ts` — mounted at `/`

| Method | Path      | What it does                    |
| :----- | :-------- | :------------------------------ |
| GET    | `/`       | Welcome message                 |
| GET    | `/health` | Health check for load balancers |

### `routes/users.routes.ts` — mounted at `/users`

| Method | Path   | Full URL     | Calls                         |
| :----- | :----- | :----------- | :---------------------------- |
| GET    | `/`    | `/users`     | `usersController.getUsers`    |
| GET    | `/:id` | `/users/123` | `usersController.getUserById` |

### Why are routes mounted at `/` inside the file?

Because in `app.ts`, you wrote:

```typescript
app.use("/users", usersRouter); // ← "/users" is the PREFIX
```

So when the router says `router.get("/")`, the full path becomes `/users` + `/` = `/users`. And `router.get("/:id")` becomes `/users/:id`.

---

## Step 7: Controllers — `controllers/`

Controllers are the waiters. They:

1.  Receive the request from the route.
2.  Call the appropriate service function.
3.  Format the response and send it back.

```typescript
// controllers/users.controller.ts
export async function getUsers(req: Request, res: Response) {
  const users = await usersService.getAllUsers(); // Ask the kitchen
  res.status(200).json({
    // Serve the food
    status: "success",
    data: users,
  });
}
```

**Why not put this logic directly in the route?** Separation of concerns. Routes define _where_, controllers define _what_, services define _how_. This makes the code easier to test and maintain as the project grows.

---

## Step 8: Services — `services/`

Services are the kitchen. This is where the actual business logic lives — database queries, calculations, external API calls, etc.

```typescript
// services/users.service.ts
export async function getAllUsers() {
  const result = await query("SELECT id, email FROM users LIMIT 100");
  return result.rows;
}
```

**Why separate from controllers?** Imagine you need to fetch users in two different places — from a REST endpoint AND from a background job. Both can call `usersService.getAllUsers()` without duplicating the SQL query.

---

## Step 9: Database — `db/index.ts`

This file creates a connection pool to PostgreSQL.

`Your app` ←→ `[Pool of 20 connections]` ←→ `PostgreSQL database`

**Why a pool?** Opening a new database connection for every request is slow (50-100ms each time). A pool keeps connections open and reuses them. Think of it like having 20 phone lines instead of dialing a new number each time.

The `query()` helper function is a convenience wrapper that:

1.  Runs the SQL.
2.  Logs duration in development (so you can spot slow queries).
3.  Returns the result.

---

## Step 10: Types — `types/index.ts`

Shared TypeScript interfaces that define the shape of your API responses:

```typescript
interface ApiResponse<T> {
  status: "success" | "error";
  statusCode: number;
  message: string;
  data?: T;
}
```

This ensures every endpoint returns the same consistent format. The frontend team will love you for this!

---

## The Full Request Lifecycle

Here's what happens when someone calls `GET /users/42`:

```mermaid
sequenceDiagram
    participant Client
    participant Middleware
    participant Router
    participant Controller
    participant Service
    participant DB

    Client->>Middleware: GET /users/42
    Note over Middleware: helmet → cors → requestId<br/>→ logger → json parser → cookie parser
    Middleware->>Router: Pass to route matching
    Router->>Router: Match: /users/:id → getUserById
    Router->>Controller: usersController.getUserById(req, res)
    Controller->>Service: usersService.getUserById("42")
    Service->>DB: SELECT * FROM users WHERE id = '42'
    DB-->>Service: { id: 42, email: "..." }
    Service-->>Controller: user object
    Controller-->>Client: 200 { status: "success", data: user }
```

---

## Suggested Reading Order

If you want to understand the codebase from scratch, read in this order:

| Order | File              | Why                                  |
| :---- | :---------------- | :----------------------------------- |
| 1     | `package.json`    | What dependencies and scripts exist. |
| 2     | `.env`            | What configuration the app needs.    |
| 3     | `config/index.ts` | How config is validated.             |
| 4     | `index.ts`        | How the server starts.               |
| 5     | `app.ts`          | How middleware and routes are wired. |
| 6     | `middleware/`     | Each middleware file.                |
| 7     | `routes/`         | URL definitions.                     |
| 8     | `controllers/`    | Request handling.                    |
| 9     | `services/`       | Business logic.                      |
| 10    | `db/index.ts`     | Database connection.                 |
| 11    | `types/`          | Shared interfaces.                   |
| 12    | `tests`           | How the app is verified.             |
