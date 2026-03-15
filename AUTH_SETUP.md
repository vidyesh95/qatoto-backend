# Authentication Architecture: Guest to Authenticated User Flow

This repository utilizes a **Shadow Account (Lazy Registration)** pattern to handle guest users. 

This architecture allows users to interact with the application (e.g., adding items to a cart, setting preferences) before creating an account. Once they sign in using Google OAuth or an Email Magic Link, all their guest data is seamlessly merged into their new permanent account.

## System Flow

The system operates across three main phases:
1. **First Visit:** Generating a secure, `HttpOnly` guest session cookie.
2. **Anonymous Collection:** Linking user actions to the temporary guest ID.
3. **Login & Merge:** Converting the guest session into a permanent Better Auth session and migrating database records.

## Sequence Diagram

```mermaid
sequenceDiagram
    participant Browser as Browser (Client)
    participant NextJS as Next.js Frontend (SSR)
    participant Express as Express Backend
    participant DB as Database

    Note over Browser, DB: Phase 1: First Visit (No Cookies)
    Browser->>NextJS: 1. Visits website
    NextJS->>Express: 2. Request (No auth/guest cookie found)
    Express->>DB: 3. Create new Guest Session record
    DB-->>Express: 4. Returns guest_id (UUID)
    Express-->>NextJS: 5. Set-Cookie: guest_session_id (HttpOnly)
    NextJS-->>Browser: 6. Render page

    Note over Browser, DB: Phase 2: Anonymous Data Collection
    Browser->>NextJS: 7. User adds item / changes preference
    NextJS->>Express: 8. API Call (Browser auto-sends guest cookie)
    Express->>DB: 9. Save data linked to guest_id
    DB-->>Browser: 10. Success

    Note over Browser, DB: Phase 3: Login & Data Merge
    Browser->>NextJS: 11. User Signs In (Google/Magic Link)
    NextJS->>Express: 12. Auth Request (includes guest cookie)
    Express->>Express: 13. Better Auth generates user_id
    Express->>DB: 14. UPDATE data SET user_id = new_user, guest_id = NULL
    Express->>DB: 15. DELETE Guest Session record
    Express-->>Browser: 16. Set-Cookie: Auth Session, Clear Guest Cookie```

---

## ⚙️ Backend Setup (Express & Better Auth)

The backend is fully configured to handle this! Better Auth automatically does all the heavy lifting in Phase 3, so you do not need to write custom SQL `UPDATE` and `DELETE` queries to merge data.

Here is what is set up in this repository:

1. **`src/lib/auth.ts`**: The Better Auth instance is configured using your existing PostgreSQL connection pool. The `anonymous()` plugin from `better-auth/plugins` is enabled.
2. **`src/app.ts`**: The server routes all requests starting with `/api/auth/*` to Better Auth.

> [!WARNING]
> Because we enabled the `anonymous` plugin, Better Auth needs to add a new `isAnonymous` column to the `user` table in your database. 
> 
> You MUST run the migration before continuing:
> ```bash
> pnpm dlx @better-auth/cli migrate
> ```

---

## 💻 Frontend Instructions (Next.js)

To connect your separate Next.js frontend to this backend, you need to set up the Better Auth client.

### 1. Install Dependencies
On your frontend project, install the client library:
```bash
pnpm add better-auth
```

### 2. Create the Auth Client
Create a file (e.g., `lib/auth-client.ts`) to configure the client:

```typescript
import { createAuthClient } from "better-auth/react" // or /vue, /svelte depending on your framework
import { anonymousClient } from "better-auth/client/plugins"

export const authClient = createAuthClient({
    // Important: Point this to your Express backend URL
    baseURL: process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000", 
    plugins: [
        anonymousClient()
    ]
})
```

### 3. Handle the Initial Visit (creating the Guest Cookie)
In a global component or hook, check if the user has a session. If they don't, trigger the anonymous sign-in process safely.

```typescript
import { useEffect } from "react";
import { authClient } from "@/lib/auth-client"

export function useGuestSession() {
    useEffect(() => {
        async function checkSession() {
            // Check if they are already a guest or logged in
            const { data: session } = await authClient.useSession();
            
            if (!session) {
                // If they have no session at all, make them a guest! 
                // This creates the shadow account and sets the secure cookie.
                await authClient.signIn.anonymous();
            }
        }
        checkSession();
    }, []);
}
```

### 4. Upgrade to a Real User
When the user clicks "Sign Up" and enters their details, just call the normal `signUp` method. Because the browser has the guest cookie, Better Auth handles the migration perfectly.

```typescript
// Inside your Registration Component
const handleSignUp = async (email, password, name) => {
    const { data, error } = await authClient.signUp.email({
        email: email,
        password: password,
        name: name
    });
    
    if (error) {
        console.error("Sign up failed", error);
    } else {
        console.log("Success! Guest account was converted.");
    }
}
```

### 5. Fetching the Active User
Anytime you need to know who the user is (their ID, their email, or if they are anonymous), you can fetch the session:

```typescript
const { data: session } = authClient.useSession()

// Output looks like:
// {
//   user: { 
//     id: 'temp-uuid', 
//     isAnonymous: true,  // <-- You can use this to show "Sign up to save progress" banners!
//     name: '...', 
//     email: '...' 
//   },
//   session: { ... }
// }
```

---

## 🧹 Database Maintenance

Because guests might visit once and never return, your database will eventually accumulate temporary accounts. 

In the future, you should set up a server CRON job or pgAgent task to run this SQL periodically to keep your database clean:

```sql
-- Delete inactive un-merged guest accounts older than 30 days
DELETE FROM "user" 
WHERE "isAnonymous" = true 
AND "updatedAt" < NOW() - INTERVAL '30 days';
```
